// The native voice engine: sessions, slots, the input stage at push, the
// output stage and mix in the AAudio callback, the tap queue and statistics.
//
// Threads, as in fsv_api.h: C control, P push, R render (AAudio callback),
// G guard (started here), D door writer. P, R and D meet the other threads
// only through atomics: each slot's audio ring, push marks and tap queue are
// single-producer single-consumer, and `busy` keeps each slot's producer
// single. Control requests that P, R and G must act on are bit flags each
// thread clears for itself.
#include <android/log.h>
#include <math.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "dsp/dsp.h"
#include "dsp/params.h"
#include "fsv_api.h"

_Static_assert(__BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__, "tap messages are written little-endian");
_Static_assert(sizeof(float) == 4, "tap samples are float32");
_Static_assert(FSV_TAP_BLOCK_BYTES == 8 + FSV_TAP_FRAMES * (int)sizeof(float), "tap block layout");
_Static_assert(4 + FSV_TAP_MAX_BLOCKS * FSV_TAP_BLOCK_BYTES <= 65536, "a tap message fits the door's buffer");

#define TAG "FireSongVoice"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, TAG, __VA_ARGS__)

#define FS ((float)FSV_RATE)
#define TWO_PI 6.283185307179586f
#define NS_MS(ms) ((int64_t)(ms) * 1000000LL)

#define RING_FRAMES 8192 /* per slot, a power of two */
#define RING_MASK (RING_FRAMES - 1)
#define MAX_PUSH 960
#define MARKS 64
#define TAP_QUEUE 32 /* blocks per slot */
#define ZERO_BLOCKS 8
#define ANALYSIS 4096
#define ANALYSIS_MASK (ANALYSIS - 1)
#define RENDER_MAX 2048
#define OUT_METER_FRAMES 2400 /* outRms and fillMs: 50 ms */

/* Ring servo, in frames. */
#define MARGIN_START 144       /* 3 ms */
#define MARGIN_MIN 96          /* 2 ms */
#define MARGIN_MAX 1920        /* 40 ms */
#define MARGIN_STEP 144        /* +3 ms per underrun */
#define MARGIN_DECAY 24        /* -0.5 ms */
#define MARGIN_DECAY_AFTER (20 * FSV_RATE) /* of play without an underrun */
#define WINDOW_FRAMES 24000    /* 500 ms */
#define TRIM_MIN 96            /* 2 ms of slack before trimming */
#define INSERT_MAX 240         /* frames replayed by one insert splice */
#define QUIET 0.01f            /* -40 dBFS */
#define FORCE_AFTER (2 * FSV_RATE)
#define CEILING 1920           /* margin + 40 ms */
#define AFTER_JUMP 240         /* margin + 5 ms */
#define PRIME_EXTRA 240        /* 5 ms, over burst + margin + one push (the fill's low point before the next push) */
#define XFADE 120              /* 2.5 ms */
#define FADE 48                /* 1 ms in after priming, out at an underrun */

/* Monitor beep. */
#define BEEP_FRAMES (FSV_BEEP_MS * FSV_RATE / 1000)
#define BEEP_ATTACK (FSV_BEEP_ATTACK_MS * FSV_RATE / 1000)
#define BEEP_RELEASE (FSV_BEEP_RELEASE_MS * FSV_RATE / 1000)
#define BEEP_LEAD (FSV_BEEP_LEAD_MS * FSV_RATE / 1000)
#define BEEP_BASELINE (FSV_BEEP_BASELINE_MS * FSV_RATE / 1000)
#define MON_HIST 512
#define MON_MASK (MON_HIST - 1)
#define MON_REFINE_STEP 16
#define TONE_FLOOR 0.0005f /* latency-test.ts threshold floor, with 3 x mean and 1.5 x peak */
#define LISTEN_AFTER_NS NS_MS(20)

#define NOTCH_REST_HZ 350.0f      /* BiquadFilterNode default frequency */
#define NOTCH_SETTLE_DB 0.0017f   /* a 1e-4 relative change of the peaking amplitude */
#define NOTCH_UPDATE 32

/* Statistics: 100 us buckets. */
#define HIST_BUCKET_US 100
#define HIST_BUCKETS 2500 /* 0-250 ms; the last bucket holds everything above */
#define STATS_WINDOW_NS NS_MS(900)

enum { REQ_RELEASE = 1, REQ_DETACH = 2, REQ_MONITOR_OFF = 4 };

/* The monitor beep's state word: (serial << 8) | code. The serial is the token. */
enum {
  MON_IDLE = 0,
  MON_BASELINE = 1, /* P measures the 1 kHz baseline */
  MON_SCHEDULE = 2, /* R schedules the beep */
  MON_BEEPING = 3,  /* R waits for the beep's presentation time */
  MON_LISTEN = 4,   /* P listens for the beep in the slot */
  MON_FOUND = 5,    /* R maps the onset to its presentation time */
  MON_DONE = 6,
  MON_FAILED = 16 /* + fsv_monitor_reason */
};
#define MON_WORD(serial, code) (((uint32_t)(serial) << 8) | (uint32_t)(code))
#define MON_CODE(word) ((int)((word) & 0xffu))
#define MON_SERIAL(word) ((word) >> 8)
#define MON_SERIAL_MAX 0xffffffu

typedef struct {
  _Atomic uint32_t seq;
  _Atomic int64_t pos; /* ring write position after the push */
  _Atomic int64_t t_ns;
} push_mark;

typedef struct {
  uint32_t made; /* P's count of completed blocks, dropped ones included */
  float samples[FSV_TAP_FRAMES];
} tap_block;

typedef struct {
  _Atomic int64_t want;  /* C: (attach serial << 32) | gen; 0 = detached */
  _Atomic uint32_t live; /* P: epoch of the generation being pushed; 0 = none */
  _Atomic int in_use;    /* C: attached since the last release */
  _Atomic int busy;      /* P: a push is running */
  _Atomic uint32_t p_req, r_req, g_req;

  _Atomic int monitor, muted, tap;
  _Atomic float volume, echo_amount;

  _Atomic int64_t write; /* P */
  _Atomic int64_t read;  /* R */
  _Atomic int push_frames; /* P: frames in the latest push */
  float ring[RING_FRAMES];

  push_mark marks[MARKS];
  _Atomic uint32_t marks_head;

  _Atomic uint32_t tap_head; /* P */
  _Atomic uint32_t tap_tail; /* D */
  _Atomic int zero_pending;
  tap_block taps[TAP_QUEUE];

  _Atomic int64_t an_w, an_reserve; /* gate output for G, behind a seqlock */
  _Atomic float an[ANALYSIS];
  _Atomic int64_t pushed;

  _Atomic float level_rms; /* P */
  _Atomic int gate_open;
  _Atomic float boost_db; /* G */
  _Atomic float feedback_hz, notch_hz, notch_db;
  _Atomic int ducked, duck_ms;
  _Atomic int fill, margin; /* R */
  _Atomic float out_rms;
  _Atomic int64_t underruns, trimmed;
} slot;

typedef struct {
  int64_t cur_want;
  uint32_t epoch;
  fsv_biquad hpf;
  fsv_gate gate;
  fsv_ramp level;
  float boost_seen;
  float acc[FSV_TAP_FRAMES];
  int acc_n;
  uint32_t made;
  uint32_t marks_n;
  int64_t last_push_ns;
  uint32_t mon_serial;
  int64_t mon_n;
  float mon_x[MON_HIST];
  int64_t mon_pos[MON_HIST];
  double base_sum;
  float base_peak, threshold;
  int base_n;
  float window[FSV_BEEP_WINDOW];
} push_state;

typedef struct {
  uint32_t live_seen;
  int active, priming, fade_in;
  int64_t margin, lowest, window, clean;
  int underrun_in_window;
  int64_t pending, pending_age; /* > 0 trim, < 0 insert */
  int insert_next;
  int64_t insert_from;
  fsv_compressor *comp;
  fsv_echo *echo;
  fsv_biquad notch;
  float notch_hz_cur, notch_db_cur;
  fsv_ramp notch_db, fader, monitor, echo_send, reverb_send;
  double out_sum;
  int out_n;
  int64_t fill_sum;
  int fill_n, fill_frames;
  uint32_t marks_tail;
  int64_t inserted;
} render_slot;

typedef struct {
  fsv_level level;
  fsv_tracker tracker;
  int64_t last;
  double now_ms, ducked_until;
  int first;
} guard_slot;

typedef struct {
  uint32_t last_made, next_seq;
} drain_slot;

typedef struct {
  _Atomic uint32_t n[HIST_BUCKETS];
  _Atomic int64_t max_us;
} hist;

typedef struct {
  float wet, feedback, lowpass_hz, reverb_send;
} echo_mix;

static slot slots[FSV_SLOTS];
static push_state pstate[FSV_SLOTS];
static render_slot rstate[FSV_SLOTS];
static guard_slot gstate[FSV_SLOTS];
static drain_slot dstate[FSV_SLOTS];

static pthread_mutex_t ctl_lock = PTHREAD_MUTEX_INITIALIZER;
static int allocated, session_token;
static uint32_t attach_serial;
static _Atomic int dsp_ready, running, d_busy, guard_run;
static pthread_t guard_thread;
static float duck_gain, trim_gain;

static _Atomic float mix_wet, mix_feedback, mix_lowpass, mix_reverb;

/* R */
static fsv_compressor *bus_comp, *limiter;
static fsv_reverb *reverb;
static int64_t r_expected;
static int beep_on;
static int64_t beep_from;
static float in_buf[FSV_SLOTS][RENDER_MAX], bus_buf[RENDER_MAX], rev_buf[RENDER_MAX], left[RENDER_MAX],
    right[RENDER_MAX];

/* G */
static float g_x[FSV_GUARD_FFT_SIZE], g_spectrum[FSV_GUARD_FFT_SIZE / 2], g_scratch[2 * FSV_GUARD_FFT_SIZE];
static int g_format_logged;
static int64_t g_format_errors_logged;

/* D */
static int d_start;
static int64_t d_last_ns;

/* Monitor beep */
static _Atomic uint32_t mon_word;
static _Atomic int mon_slot;
static _Atomic int64_t mon_t_b, mon_pos_on;
static _Atomic float mon_ms;
static uint32_t mon_serial_c;
static int64_t mon_started_ns;

/* Statistics */
static hist h_callback, h_push, h_present, h_drain;
static _Atomic int64_t callbacks, tap_dropped, format_errors, format_seen, format_bad;
static _Atomic int peak_q15;
static pthread_mutex_t stats_lock = PTHREAD_MUTEX_INITIALIZER;
static uint32_t snap_callback[HIST_BUCKETS], snap_push[HIST_BUCKETS], snap_present[HIST_BUCKETS],
    snap_drain[HIST_BUCKETS];
static uint32_t delta[HIST_BUCKETS];
static int64_t window_started_ns;
static int64_t w_callback_p99, w_callback_max, w_push_p50, w_push_p99, w_push_max, w_present_p50, w_present_p95,
    w_drain_p99, w_drain_max;

/* aaudio_out.c */
int64_t ao_open_attempts(void);

static int64_t now_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static float db_to_gain(float db) { return powf(10.0f, db / 20.0f); }

static slot *slot_at(int slot_no) { return slot_no >= 1 && slot_no <= FSV_SLOTS ? &slots[slot_no - 1] : NULL; }

static void max_update(_Atomic int64_t *max, int64_t value) {
  int64_t cur = atomic_load_explicit(max, memory_order_relaxed);
  while (value > cur && !atomic_compare_exchange_weak_explicit(max, &cur, value, memory_order_relaxed,
                                                               memory_order_relaxed)) {
  }
}

static void hist_add(hist *h, int64_t us) {
  if (us < 0) us = 0;
  int64_t bucket = us / HIST_BUCKET_US;
  if (bucket >= HIST_BUCKETS) bucket = HIST_BUCKETS - 1;
  atomic_fetch_add_explicit(&h->n[bucket], 1, memory_order_relaxed);
  max_update(&h->max_us, us);
}

static int mon_pending(int code) { return code >= MON_BASELINE && code <= MON_FOUND; }

static int mon_measuring(uint32_t word, int index) {
  return mon_pending(MON_CODE(word)) && atomic_load_explicit(&mon_slot, memory_order_relaxed) == index;
}

/* Moves a running measurement to FAILED; returns 1 when this call did it. */
static int mon_fail(uint32_t word, int reason) {
  return atomic_compare_exchange_strong(&mon_word, &word, MON_WORD(MON_SERIAL(word), MON_FAILED + reason));
}

static void mon_fail_any(int reason) {
  uint32_t word = atomic_load(&mon_word);
  while (mon_pending(MON_CODE(word)) && !mon_fail(word, reason)) word = atomic_load(&mon_word);
}

static void mon_fail_slot(int index, int reason) {
  uint32_t word = atomic_load(&mon_word);
  while (mon_measuring(word, index) && !mon_fail(word, reason)) word = atomic_load(&mon_word);
}

/* ---- Session state ---------------------------------------------------------------------------------- */

static void init_render_dsp(render_slot *rs) {
  fsv_compressor_reset(rs->comp);
  fsv_echo_reset(rs->echo);
  fsv_biquad_peaking(&rs->notch, FS, NOTCH_REST_HZ, FSV_FEEDBACK_NOTCH_Q, 0.0f);
  fsv_biquad_reset(&rs->notch);
  rs->notch_hz_cur = NOTCH_REST_HZ;
  rs->notch_db_cur = 0.0f;
  fsv_ramp_init(&rs->notch_db, FS, FSV_RAMP_SEC, 0.0f);
  fsv_ramp_init(&rs->fader, FS, FSV_RAMP_SEC, 1.0f);
  fsv_ramp_init(&rs->monitor, FS, FSV_RAMP_SEC, 0.0f);
  fsv_ramp_init(&rs->echo_send, FS, FSV_RAMP_SEC, 0.0f);
  fsv_ramp_init(&rs->reverb_send, FS, FSV_RAMP_SEC, 0.0f);
  rs->out_sum = 0.0;
  rs->out_n = 0;
}

static void start_priming(render_slot *rs, int64_t margin) {
  rs->priming = 1;
  rs->fade_in = 0;
  rs->margin = margin;
  rs->lowest = INT64_MAX;
  rs->window = 0;
  rs->clean = 0;
  rs->underrun_in_window = 0;
  rs->pending = 0;
  rs->pending_age = 0;
  rs->insert_next = 0;
}

static void reset_level(push_state *ps) {
  fsv_ramp_init(&ps->level, FS, FSV_BOOST_RAMP_SEC, db_to_gain(FSV_VOICE_START_BOOST_DB));
  ps->boost_seen = FSV_VOICE_START_BOOST_DB;
}

static void reset_duck(slot *s, guard_slot *gs) {
  gs->ducked_until = 0.0;
  atomic_store(&s->ducked, 0);
  atomic_store(&s->duck_ms, 0);
  atomic_store(&s->feedback_hz, 0.0f);
  atomic_store(&s->notch_db, 0.0f);
}

static void set_controls_default(slot *s) {
  atomic_store(&s->monitor, 0);
  atomic_store(&s->muted, 0);
  atomic_store(&s->tap, 0);
  atomic_store(&s->volume, 1.0f);
  atomic_store(&s->echo_amount, 1.0f);
}

static void set_mix_default(void) {
  atomic_store(&mix_wet, FSV_ECHO_WET_GAIN);
  atomic_store(&mix_feedback, FSV_ECHO_FEEDBACK);
  atomic_store(&mix_lowpass, FSV_ECHO_LOWPASS_HZ);
  atomic_store(&mix_reverb, FSV_REVERB_SEND);
}

/* Only while no other engine thread runs: before a session starts or after it stopped. */
static int reset_all(void) {
  for (int i = 0; i < FSV_SLOTS; i++) {
    slot *s = &slots[i];
    atomic_store(&s->want, 0);
    atomic_store(&s->live, 0);
    atomic_store(&s->in_use, 0);
    atomic_store(&s->busy, 0);
    atomic_store(&s->p_req, 0);
    atomic_store(&s->r_req, 0);
    atomic_store(&s->g_req, 0);
    set_controls_default(s);
    atomic_store(&s->write, 0);
    atomic_store(&s->read, 0);
    atomic_store(&s->push_frames, 0);
    for (int m = 0; m < MARKS; m++) atomic_store(&s->marks[m].seq, 0);
    atomic_store(&s->marks_head, 0);
    atomic_store(&s->tap_head, 0);
    atomic_store(&s->tap_tail, 0);
    atomic_store(&s->zero_pending, 0);
    atomic_store(&s->an_w, 0);
    atomic_store(&s->an_reserve, 0);
    for (int k = 0; k < ANALYSIS; k++) atomic_store_explicit(&s->an[k], 0.0f, memory_order_relaxed);
    atomic_store(&s->pushed, 0);
    atomic_store(&s->level_rms, 0.0f);
    atomic_store(&s->gate_open, 0);
    atomic_store(&s->boost_db, FSV_VOICE_START_BOOST_DB);
    atomic_store(&s->notch_hz, 0.0f);
    atomic_store(&s->fill, 0);
    atomic_store(&s->margin, MARGIN_START);
    atomic_store(&s->out_rms, 0.0f);
    atomic_store(&s->underruns, 0);
    atomic_store(&s->trimmed, 0);

    push_state *ps = &pstate[i];
    memset(ps, 0, sizeof(*ps));
    reset_level(ps);

    render_slot *rs = &rstate[i];
    fsv_compressor *comp = rs->comp;
    fsv_echo *echo = rs->echo;
    memset(rs, 0, sizeof(*rs));
    rs->comp = comp;
    rs->echo = echo;
    fsv_compressor_init(comp, FS, FSV_COMPRESSOR_THRESHOLD_DB, FSV_COMPRESSOR_KNEE_DB, FSV_COMPRESSOR_RATIO,
                        FSV_COMPRESSOR_ATTACK_SEC, FSV_COMPRESSOR_RELEASE_SEC);
    fsv_echo_init(echo, FS);
    fsv_echo_set(echo, FSV_ECHO_FEEDBACK, FSV_ECHO_LOWPASS_HZ);
    init_render_dsp(rs);
    start_priming(rs, MARGIN_START);

    guard_slot *gs = &gstate[i];
    memset(gs, 0, sizeof(*gs));
    fsv_level_init(&gs->level);
    fsv_tracker_reset(&gs->tracker);
    gs->first = 1;
    reset_duck(s, gs);

    memset(&dstate[i], 0, sizeof(dstate[i]));
  }
  set_mix_default();
  fsv_compressor_init(bus_comp, FS, FSV_BUS_COMPRESSOR_THRESHOLD_DB, FSV_COMPRESSOR_KNEE_DB,
                      FSV_BUS_COMPRESSOR_RATIO, FSV_COMPRESSOR_ATTACK_SEC, FSV_COMPRESSOR_RELEASE_SEC);
  fsv_compressor_init(limiter, FS, FSV_LIMITER_THRESHOLD_DB, FSV_LIMITER_KNEE_DB, FSV_LIMITER_RATIO,
                      FSV_LIMITER_ATTACK_SEC, FSV_LIMITER_RELEASE_SEC);
  if (fsv_reverb_init(reverb, FS, FSV_REVERB_SECONDS, FSV_REVERB_ENERGY_GAIN_DB) != 0) return 0;
  duck_gain = db_to_gain(FSV_FEEDBACK_DUCK_DB);
  trim_gain = db_to_gain(FSV_VOICE_TRIM_DB);
  r_expected = -1;
  beep_on = 0;
  beep_from = 0;
  g_format_logged = 0;
  g_format_errors_logged = 0;
  d_start = 0;
  d_last_ns = 0;
  atomic_store(&mon_word, MON_IDLE);
  atomic_store(&mon_slot, -1);
  atomic_store(&callbacks, 0);
  atomic_store(&tap_dropped, 0);
  atomic_store(&format_errors, 0);
  atomic_store(&format_seen, 0);
  atomic_store(&format_bad, 0);
  atomic_store(&peak_q15, 0);
  return 1;
}

static void *alloc_dsp(int size) { return size > 0 ? calloc(1, (size_t)size) : NULL; }

/* Once per process: the opaque DSP objects, sized by dsp.c at run time. Never freed. */
static int allocate(void) {
  if (allocated) return 1;
  int comp_size = fsv_compressor_size();
  int echo_size = fsv_echo_size();
  bus_comp = alloc_dsp(comp_size);
  limiter = alloc_dsp(comp_size);
  reverb = alloc_dsp(fsv_reverb_size());
  int ok = bus_comp != NULL && limiter != NULL && reverb != NULL;
  for (int i = 0; i < FSV_SLOTS; i++) {
    rstate[i].comp = alloc_dsp(comp_size);
    rstate[i].echo = alloc_dsp(echo_size);
    ok = ok && rstate[i].comp != NULL && rstate[i].echo != NULL;
  }
  if (!ok) {
    free(bus_comp);
    free(limiter);
    free(reverb);
    for (int i = 0; i < FSV_SLOTS; i++) {
      free(rstate[i].comp);
      free(rstate[i].echo);
      rstate[i].comp = NULL;
      rstate[i].echo = NULL;
    }
    bus_comp = limiter = NULL;
    reverb = NULL;
    return 0;
  }
  allocated = 1;
  return 1;
}

/* ---- Guard thread (G) ------------------------------------------------------------------------------- */

/* The latest FSV_GUARD_FFT_SIZE gate-output samples; 0 when P overwrote them while copying. */
static int copy_analysis(slot *s, float *x) {
  for (int attempt = 0; attempt < 3; attempt++) {
    int64_t w = atomic_load_explicit(&s->an_w, memory_order_acquire);
    if (w < FSV_GUARD_FFT_SIZE) return 0;
    int64_t from = w - FSV_GUARD_FFT_SIZE;
    for (int k = 0; k < FSV_GUARD_FFT_SIZE; k++) {
      x[k] = atomic_load_explicit(&s->an[(from + k) & ANALYSIS_MASK], memory_order_relaxed);
    }
    atomic_thread_fence(memory_order_acquire);
    int64_t reserved = atomic_load_explicit(&s->an_reserve, memory_order_relaxed);
    if (reserved - from <= ANALYSIS) return 1;
  }
  return 0;
}

static void publish_boost(slot *s, const guard_slot *gs) { atomic_store(&s->boost_db, gs->level.boost_db); }

/* One guard step for a slot, every 2400 pushed frames (mic-rack.ts guard and levelVoice). */
static void guard_tick(int index, slot *s, guard_slot *gs) {
  gs->now_ms += 1000.0 * FSV_GUARD_FRAMES / FSV_RATE;
  float elapsed = gs->first ? 0.0f : (float)FSV_GUARD_FRAMES / FSV_RATE;
  gs->first = 0;
  if (fsv_level_step(&gs->level, atomic_load(&s->level_rms), atomic_load(&s->gate_open), elapsed)) {
    publish_boost(s, gs);
  }
  if (gs->ducked_until != 0.0 && gs->now_ms >= gs->ducked_until) reset_duck(s, gs);
  int monitored = atomic_load(&s->monitor) && !mon_measuring(atomic_load(&mon_word), index);
  if (monitored && copy_analysis(s, g_x)) {
    fsv_spectrum_db(g_x, g_spectrum, g_scratch);
    fsv_peak peak;
    int found = fsv_find_feedback_peak(g_spectrum, FSV_GUARD_FFT_SIZE / 2, FS, &peak);
    float howl = fsv_tracker_update(&gs->tracker, found ? &peak : NULL, gs->now_ms);
    if (howl > 0.0f) {
      atomic_store(&s->feedback_hz, howl);
      fsv_level_howl(&gs->level);
      publish_boost(s, gs);
      atomic_store(&s->notch_hz, howl);
      atomic_store(&s->notch_db, FSV_FEEDBACK_NOTCH_DB);
      gs->ducked_until = gs->now_ms + FSV_FEEDBACK_RELEASE_MS;
      atomic_store(&s->ducked, 1);
    } else if (found && gs->ducked_until != 0.0) {
      gs->ducked_until = gs->now_ms + FSV_FEEDBACK_RELEASE_MS;
    }
  }
  atomic_store(&s->duck_ms, gs->ducked_until != 0.0 ? (int)(gs->ducked_until - gs->now_ms) : 0);
}

static void guard_slot_step(int index) {
  slot *s = &slots[index];
  guard_slot *gs = &gstate[index];
  uint32_t req = atomic_exchange(&s->g_req, 0);
  if (req & REQ_RELEASE) {
    fsv_level_init(&gs->level);
    gs->first = 1;
    publish_boost(s, gs);
  }
  if (req & (REQ_RELEASE | REQ_DETACH | REQ_MONITOR_OFF)) fsv_tracker_reset(&gs->tracker);
  if (req & (REQ_RELEASE | REQ_DETACH)) reset_duck(s, gs);
  int64_t pushed = atomic_load(&s->pushed);
  if (atomic_load(&s->live) == 0) {
    gs->last = pushed;
    return;
  }
  for (int n = 0; pushed - gs->last >= FSV_GUARD_FRAMES; n++) {
    if (n == 4) {
      gs->last = pushed - (pushed - gs->last) % FSV_GUARD_FRAMES;
      break;
    }
    guard_tick(index, s, gs);
    gs->last += FSV_GUARD_FRAMES;
  }
}

static void guard_log(void) {
  int64_t seen = atomic_load(&format_seen);
  if (seen != 0 && !g_format_logged) {
    g_format_logged = 1;
    LOGI("first push: %d Hz, %d ch", (int)(seen >> 8), (int)(seen & 0xff));
  }
  int64_t errors = atomic_load(&format_errors);
  if (errors != 0 && g_format_errors_logged == 0) {
    int64_t bad = atomic_load(&format_bad);
    g_format_errors_logged = errors;
    LOGW("push rejected: %d Hz, %d ch (only %d Hz, 1 or 2 ch)", (int)(bad >> 8), (int)(bad & 0xff), FSV_RATE);
  }
}

static void *guard_main(void *arg) {
  (void)arg;
  pthread_setname_np(pthread_self(), "fsv-guard");
  const struct timespec tick = {0, 10000000L};
  while (atomic_load(&guard_run)) {
    clock_nanosleep(CLOCK_MONOTONIC, 0, &tick, NULL);
    for (int i = 0; i < FSV_SLOTS; i++) guard_slot_step(i);
    guard_log();
  }
  return NULL;
}

/* ---- Control (C) ------------------------------------------------------------------------------------ */

static int next_token(void) {
  session_token = session_token >= 0x7fffffff ? 1 : session_token + 1;
  return session_token;
}

static void release_locked(int index) {
  slot *s = &slots[index];
  if (atomic_load(&s->want) != 0 && atomic_load(&s->tap)) atomic_store(&s->zero_pending, ZERO_BLOCKS);
  atomic_store(&s->want, 0);
  atomic_store(&s->live, 0);
  set_controls_default(s);
  atomic_store(&s->in_use, 0);
  atomic_store(&s->level_rms, 0.0f);
  atomic_store(&s->gate_open, 0);
  atomic_store(&s->boost_db, FSV_VOICE_START_BOOST_DB);
  atomic_store(&s->feedback_hz, 0.0f);
  atomic_store(&s->duck_ms, 0);
  atomic_fetch_or(&s->p_req, REQ_RELEASE);
  atomic_fetch_or(&s->r_req, REQ_RELEASE);
  atomic_fetch_or(&s->g_req, REQ_RELEASE);
  mon_fail_slot(index, FSV_MONITOR_STOPPED);
}

static void stop_guard(void) {
  atomic_store(&guard_run, 0);
  pthread_join(guard_thread, NULL);
}

int fsv_start(void) {
  pthread_mutex_lock(&ctl_lock);
  int result;
  if (atomic_load(&running)) {
    for (int i = 0; i < FSV_SLOTS; i++) release_locked(i);
    set_mix_default();
    mon_fail_any(FSV_MONITOR_STOPPED);
    result = next_token();
    LOGI("session %d replaces the running one", result);
  } else if (!allocate() || !reset_all()) {
    result = FSV_ERR_STATE;
  } else {
    atomic_store_explicit(&dsp_ready, 1, memory_order_release);
    atomic_store(&running, 1);
    atomic_store(&guard_run, 1);
    if (pthread_create(&guard_thread, NULL, guard_main, NULL) != 0) {
      atomic_store(&running, 0);
      result = FSV_ERR_STATE;
    } else {
      int audio = ao_open(fsv_render);
      if (audio != FSV_OK && audio != FSV_ERR_AUDIO) {
        stop_guard();
        atomic_store(&running, 0);
        result = FSV_ERR_STATE;
      } else {
        result = next_token();
        LOGI("session %d: audio %s", result, audio == FSV_OK ? "open" : "pending");
      }
    }
  }
  pthread_mutex_unlock(&ctl_lock);
  return result;
}

void fsv_stop(int token) {
  pthread_mutex_lock(&ctl_lock);
  if (token == session_token && atomic_load(&running)) {
    atomic_store(&running, 0);
    for (int i = 0; i < FSV_SLOTS; i++) {
      while (atomic_load(&slots[i].busy)) sched_yield();
    }
    while (atomic_load(&d_busy)) sched_yield();
    stop_guard();
    ao_close();
    mon_fail_any(FSV_MONITOR_STOPPED);
    reset_all();
    LOGI("session %d stopped", token);
  }
  pthread_mutex_unlock(&ctl_lock);
}

void fsv_attach(int slot_no, int gen) {
  slot *s = slot_at(slot_no);
  if (s == NULL) return;
  pthread_mutex_lock(&ctl_lock);
  if (atomic_load(&running)) {
    attach_serial = attach_serial >= 0x7fffffffu ? 1 : attach_serial + 1;
    mon_fail_slot(slot_no - 1, FSV_MONITOR_STOPPED);
    atomic_store(&s->in_use, 1);
    atomic_store(&s->want, ((int64_t)attach_serial << 32) | (uint32_t)gen);
    atomic_store(&s->live, 0);
  }
  pthread_mutex_unlock(&ctl_lock);
}

void fsv_detach(int slot_no, int gen) {
  slot *s = slot_at(slot_no);
  if (s == NULL) return;
  pthread_mutex_lock(&ctl_lock);
  int64_t want = atomic_load(&s->want);
  if (atomic_load(&running) && want != 0 && (uint32_t)want == (uint32_t)gen) {
    atomic_store(&s->want, 0);
    atomic_store(&s->live, 0);
    if (atomic_load(&s->tap)) atomic_store(&s->zero_pending, ZERO_BLOCKS);
    atomic_fetch_or(&s->g_req, REQ_DETACH);
    mon_fail_slot(slot_no - 1, FSV_MONITOR_STOPPED);
  }
  pthread_mutex_unlock(&ctl_lock);
}

void fsv_release(int slot_no) {
  if (slot_at(slot_no) == NULL) return;
  pthread_mutex_lock(&ctl_lock);
  if (atomic_load(&running)) release_locked(slot_no - 1);
  pthread_mutex_unlock(&ctl_lock);
}

int fsv_set(int slot_no, int control, float value) {
  slot *s = slot_at(slot_no);
  if (s == NULL || !isfinite(value)) return FSV_ERR_ARG;
  pthread_mutex_lock(&ctl_lock);
  int result = FSV_OK;
  if (!atomic_load(&running)) {
    result = FSV_ERR_STATE;
  } else {
    switch (control) {
      case FSV_MONITOR:
        atomic_store(&s->monitor, value != 0.0f);
        if (value == 0.0f) atomic_fetch_or(&s->g_req, REQ_MONITOR_OFF);
        break;
      case FSV_MUTED:
        atomic_store(&s->muted, value != 0.0f);
        break;
      case FSV_VOLUME:
        if (value < 0.0f || value > 1.5f) result = FSV_ERR_ARG;
        else atomic_store(&s->volume, value);
        break;
      case FSV_ECHO_AMOUNT:
        if (value < 0.0f || value > 2.0f) result = FSV_ERR_ARG;
        else atomic_store(&s->echo_amount, value);
        break;
      case FSV_TAP:
        atomic_store(&s->tap, value != 0.0f);
        if (value == 0.0f) atomic_store(&s->zero_pending, 0);
        break;
      default:
        result = FSV_ERR_ARG;
    }
  }
  pthread_mutex_unlock(&ctl_lock);
  return result;
}

int fsv_set_echo_mix(float wet, float feedback, float lowpass_hz, float reverb_send) {
  if (!(wet >= 0.0f && wet <= 1.0f) || !(feedback >= 0.0f && feedback <= 0.95f) ||
      !(lowpass_hz >= 500.0f && lowpass_hz <= 20000.0f) || !(reverb_send >= 0.0f && reverb_send <= 1.0f)) {
    return FSV_ERR_ARG;
  }
  pthread_mutex_lock(&ctl_lock);
  int result = FSV_ERR_STATE;
  if (atomic_load(&running)) {
    atomic_store(&mix_wet, wet);
    atomic_store(&mix_feedback, feedback);
    atomic_store(&mix_lowpass, lowpass_hz);
    atomic_store(&mix_reverb, reverb_send);
    result = FSV_OK;
  }
  pthread_mutex_unlock(&ctl_lock);
  return result;
}

static int output_open(void) {
  int64_t burst, buffer, xruns, latency, restarts, open;
  ao_stats(&burst, &buffer, &xruns, &latency, &restarts, &open);
  return open != 0;
}

/* Fails a measurement whose thread stopped advancing it (no pushes, no output). */
static void mon_expire(int64_t now) {
  uint32_t word = atomic_load(&mon_word);
  int code = MON_CODE(word);
  int64_t elapsed = now - mon_started_ns;
  int64_t t_b = atomic_load(&mon_t_b);
  if (code == MON_BASELINE && elapsed > NS_MS(FSV_BEEP_BASELINE_MS + 1000)) {
    mon_fail(word, FSV_MONITOR_NO_AUDIO);
  } else if ((code == MON_SCHEDULE || code == MON_BEEPING) &&
             elapsed > NS_MS(FSV_BEEP_BASELINE_MS + FSV_BEEP_LEAD_MS + 1000)) {
    mon_fail(word, FSV_MONITOR_STOPPED);
  } else if (code == MON_LISTEN && now > t_b + NS_MS(FSV_BEEP_TIMEOUT_MS)) {
    mon_fail(word, FSV_MONITOR_NO_TONE);
  } else if (code == MON_FOUND && now > t_b + NS_MS(FSV_BEEP_TIMEOUT_MS + 500)) {
    mon_fail(word, FSV_MONITOR_STOPPED);
  }
}

int fsv_measure_monitor(int slot_no) {
  pthread_mutex_lock(&ctl_lock);
  int result;
  if (!atomic_load(&running) || !output_open()) {
    result = -FSV_MONITOR_STOPPED;
  } else if (slot_at(slot_no) == NULL || atomic_load(&slots[slot_no - 1].live) == 0) {
    result = -FSV_MONITOR_NO_AUDIO;
  } else {
    int64_t now = now_ns();
    mon_expire(now);
    if (mon_pending(MON_CODE(atomic_load(&mon_word)))) {
      result = -FSV_MONITOR_BUSY;
    } else {
      mon_serial_c = mon_serial_c >= MON_SERIAL_MAX ? 1 : mon_serial_c + 1;
      mon_started_ns = now;
      atomic_store(&mon_slot, slot_no - 1);
      atomic_store(&mon_t_b, 0);
      atomic_store(&mon_ms, 0.0f);
      atomic_store_explicit(&mon_word, MON_WORD(mon_serial_c, MON_BASELINE), memory_order_release);
      result = (int)mon_serial_c;
    }
  }
  pthread_mutex_unlock(&ctl_lock);
  return result;
}

void fsv_monitor_result(int token, float out[3]) {
  pthread_mutex_lock(&ctl_lock);
  out[0] = FSV_MONITOR_FAILED;
  out[1] = 0.0f;
  out[2] = FSV_MONITOR_STOPPED;
  if (token > 0 && (uint32_t)token == mon_serial_c) {
    mon_expire(now_ns());
    uint32_t word = atomic_load(&mon_word);
    int code = MON_CODE(word);
    if (mon_pending(code)) {
      out[0] = FSV_MONITOR_PENDING;
      out[2] = 0.0f;
    } else if (code == MON_DONE) {
      out[0] = FSV_MONITOR_DONE;
      out[1] = atomic_load(&mon_ms);
      out[2] = 0.0f;
    } else if (code > MON_FAILED) {
      out[2] = (float)(code - MON_FAILED);
    }
  }
  pthread_mutex_unlock(&ctl_lock);
}

/* ---- Push (P) --------------------------------------------------------------------------------------- */

static void start_generation(slot *s, push_state *ps, int64_t want) {
  ps->cur_want = want;
  fsv_biquad_highpass(&ps->hpf, FS, FSV_HPF_HZ, 1.0f);
  fsv_biquad_reset(&ps->hpf);
  fsv_gate_init(&ps->gate, FS, FSV_GATE_THRESHOLD);
  ps->acc_n = 0;
  ps->last_push_ns = 0;
  int64_t w = atomic_load_explicit(&s->an_w, memory_order_relaxed);
  atomic_store_explicit(&s->an_reserve, w + ANALYSIS, memory_order_relaxed);
  atomic_thread_fence(memory_order_release);
  for (int k = 0; k < ANALYSIS; k++) atomic_store_explicit(&s->an[k], 0.0f, memory_order_relaxed);
  atomic_store_explicit(&s->an_w, w + ANALYSIS, memory_order_release);
  ps->epoch = ps->epoch >= UINT32_MAX - 1 ? 1 : ps->epoch + 1;
  atomic_store(&s->live, ps->epoch);
  if (atomic_load(&s->want) != want) {
    uint32_t epoch = ps->epoch;
    atomic_compare_exchange_strong(&s->live, &epoch, 0);
  }
}

static float goertzel_at(push_state *ps, int64_t end) {
  for (int k = 0; k < FSV_BEEP_WINDOW; k++) ps->window[k] = ps->mon_x[(end - FSV_BEEP_WINDOW + k) & MON_MASK];
  return fsv_goertzel_amp(ps->window, FSV_BEEP_WINDOW, FS, FSV_BEEP_HZ);
}

/* The ring position where the tone starts, to 16 samples, within the hop that first crossed the threshold. */
static int64_t onset_pos(push_state *ps) {
  int64_t hop_start = ps->mon_n - FSV_BEEP_HOP;
  for (int64_t end = hop_start + MON_REFINE_STEP; end < ps->mon_n; end += MON_REFINE_STEP) {
    if (goertzel_at(ps, end) >= ps->threshold) return ps->mon_pos[(end - MON_REFINE_STEP / 2) & MON_MASK];
  }
  return ps->mon_pos[(ps->mon_n - MON_REFINE_STEP / 2) & MON_MASK];
}

/* One hop of the beep detector; returns the state word to continue with (0: stop for this push). */
static uint32_t mon_hop(push_state *ps, uint32_t word, int64_t t_push) {
  int code = MON_CODE(word);
  if (code == MON_BASELINE) {
    float amp = goertzel_at(ps, ps->mon_n);
    ps->base_sum += amp;
    ps->base_n++;
    if (amp > ps->base_peak) ps->base_peak = amp;
    if (ps->mon_n >= BEEP_BASELINE) {
      float mean = (float)(ps->base_sum / ps->base_n);
      ps->threshold = fmaxf(TONE_FLOOR, fmaxf(3.0f * mean, 1.5f * ps->base_peak));
      uint32_t next = MON_WORD(MON_SERIAL(word), MON_SCHEDULE);
      return atomic_compare_exchange_strong(&mon_word, &word, next) ? next : 0;
    }
  } else if (code == MON_LISTEN) {
    int64_t t_b = atomic_load_explicit(&mon_t_b, memory_order_relaxed);
    if (t_push > t_b + NS_MS(FSV_BEEP_TIMEOUT_MS)) {
      mon_fail(word, FSV_MONITOR_NO_TONE);
      return 0;
    }
    if (t_push >= t_b + LISTEN_AFTER_NS && goertzel_at(ps, ps->mon_n) >= ps->threshold) {
      int64_t pos = onset_pos(ps);
      if (pos < 0) {
        mon_fail(word, FSV_MONITOR_STOPPED);
        return 0;
      }
      atomic_store_explicit(&mon_pos_on, pos, memory_order_relaxed);
      uint32_t next = MON_WORD(MON_SERIAL(word), MON_FOUND);
      atomic_compare_exchange_strong(&mon_word, &word, next);
      return 0;
    }
  }
  return word;
}

static void put_mark(slot *s, push_state *ps, int64_t pos, int64_t t) {
  uint32_t index = ps->marks_n++;
  push_mark *m = &s->marks[index % MARKS];
  atomic_store_explicit(&m->seq, 0, memory_order_relaxed);
  atomic_thread_fence(memory_order_release);
  atomic_store_explicit(&m->pos, pos, memory_order_relaxed);
  atomic_store_explicit(&m->t_ns, t, memory_order_relaxed);
  atomic_store_explicit(&m->seq, index + 1, memory_order_release);
  atomic_store_explicit(&s->marks_head, index + 1, memory_order_release);
}

static void tap_block_done(slot *s, push_state *ps) {
  ps->acc_n = 0;
  ps->made++;
  uint32_t head = atomic_load_explicit(&s->tap_head, memory_order_relaxed);
  uint32_t tail = atomic_load_explicit(&s->tap_tail, memory_order_acquire);
  if (head - tail >= TAP_QUEUE) {
    atomic_fetch_add_explicit(&tap_dropped, 1, memory_order_relaxed);
    return;
  }
  tap_block *b = &s->taps[head % TAP_QUEUE];
  b->made = ps->made;
  memcpy(b->samples, ps->acc, sizeof(b->samples));
  atomic_store_explicit(&s->tap_head, head + 1, memory_order_release);
}

static int push_owned(int index, slot *s, int gen, const int16_t *pcm, int frames, int channels) {
  push_state *ps = &pstate[index];
  int64_t want = atomic_load(&s->want);
  if (want == 0 || (uint32_t)want != (uint32_t)gen) return FSV_ERR_STALE;
  int64_t t = now_ns();
  if (want != ps->cur_want) start_generation(s, ps, want);
  if (atomic_exchange_explicit(&s->p_req, 0, memory_order_acq_rel) & REQ_RELEASE) reset_level(ps);
  if (ps->last_push_ns != 0) hist_add(&h_push, (t - ps->last_push_ns) / 1000);
  ps->last_push_ns = t;

  float boost = atomic_load_explicit(&s->boost_db, memory_order_relaxed);
  if (boost != ps->boost_seen) {
    ps->boost_seen = boost;
    ps->level.target = db_to_gain(boost);
  }

  int64_t w = atomic_load_explicit(&s->write, memory_order_relaxed);
  int64_t r = atomic_load_explicit(&s->read, memory_order_acquire);
  int to_ring = RING_FRAMES - (w - r) >= frames;
  int tap_on = atomic_load_explicit(&s->tap, memory_order_relaxed);
  if (!tap_on) ps->acc_n = 0;
  int64_t an_w = atomic_load_explicit(&s->an_w, memory_order_relaxed);
  atomic_store_explicit(&s->an_reserve, an_w + frames, memory_order_relaxed);
  atomic_thread_fence(memory_order_release);

  uint32_t word = atomic_load_explicit(&mon_word, memory_order_acquire);
  int measuring = mon_measuring(word, index) && MON_CODE(word) != MON_FOUND;
  if (measuring && MON_SERIAL(word) != ps->mon_serial) {
    ps->mon_serial = MON_SERIAL(word);
    ps->mon_n = 0;
    ps->base_sum = 0.0;
    ps->base_peak = 0.0f;
    ps->base_n = 0;
  }

  for (int i = 0; i < frames; i++) {
    float x = channels == 2 ? ((float)pcm[2 * i] + (float)pcm[2 * i + 1]) * (0.5f / 32768.0f)
                            : (float)pcm[i] * (1.0f / 32768.0f);
    int meter_ready = 0, meter_open = 0;
    float meter_rms = 0.0f;
    float g = fsv_gate_run(&ps->gate, fsv_biquad_run(&ps->hpf, x), &meter_ready, &meter_rms, &meter_open);
    if (meter_ready) {
      atomic_store_explicit(&s->level_rms, meter_rms, memory_order_relaxed);
      atomic_store_explicit(&s->gate_open, meter_open, memory_order_relaxed);
    }
    atomic_store_explicit(&s->an[(an_w + i) & ANALYSIS_MASK], g, memory_order_relaxed);
    float y = g * fsv_ramp_next(&ps->level);
    if (tap_on) {
      ps->acc[ps->acc_n++] = y;
      if (ps->acc_n == FSV_TAP_FRAMES) tap_block_done(s, ps);
    }
    if (to_ring) s->ring[(w + i) & RING_MASK] = y;
    if (word != 0 && measuring) {
      ps->mon_x[ps->mon_n & MON_MASK] = y;
      ps->mon_pos[ps->mon_n & MON_MASK] = to_ring ? w + i : -1;
      ps->mon_n++;
      if (ps->mon_n >= FSV_BEEP_WINDOW && ps->mon_n % FSV_BEEP_HOP == 0) word = mon_hop(ps, word, t);
    }
  }

  atomic_store_explicit(&s->an_w, an_w + frames, memory_order_release);
  atomic_store_explicit(&s->push_frames, frames, memory_order_relaxed);
  if (to_ring) {
    atomic_store_explicit(&s->write, w + frames, memory_order_release);
    put_mark(s, ps, w + frames, t);
  }
  atomic_fetch_add_explicit(&s->pushed, frames, memory_order_relaxed);
  uint32_t head = atomic_load_explicit(&s->tap_head, memory_order_relaxed);
  return (int)(head - atomic_load_explicit(&s->tap_tail, memory_order_acquire));
}

int fsv_push(int slot_no, int gen, const int16_t *pcm, int frames, int rate, int channels) {
  slot *s = slot_at(slot_no);
  if (s == NULL || pcm == NULL || frames < 1 || frames > MAX_PUSH) return FSV_ERR_ARG;
  int64_t format = ((int64_t)rate << 8) | (channels & 0xff);
  if (rate != FSV_RATE || (channels != 1 && channels != 2)) {
    atomic_store_explicit(&format_bad, format, memory_order_relaxed);
    atomic_fetch_add_explicit(&format_errors, 1, memory_order_relaxed);
    return FSV_ERR_FORMAT;
  }
  if (atomic_exchange(&s->busy, 1)) return FSV_ERR_STATE;
  int result = FSV_ERR_STATE;
  if (atomic_load(&running)) {
    int64_t none = 0;
    if (atomic_load_explicit(&format_seen, memory_order_relaxed) == 0) {
      atomic_compare_exchange_strong_explicit(&format_seen, &none, format, memory_order_relaxed,
                                              memory_order_relaxed);
    }
    result = push_owned(slot_no - 1, s, gen, pcm, frames, channels);
  }
  atomic_store_explicit(&s->busy, 0, memory_order_release);
  return result;
}

/* ---- Render (R) ------------------------------------------------------------------------------------- */

static int quiet_span(const slot *s, int64_t from, int64_t frames) {
  for (int64_t k = 0; k < frames; k++) {
    float v = s->ring[(from + k) & RING_MASK];
    if (v >= QUIET || v <= -QUIET) return 0;
  }
  return 1;
}

static void copy_ring(const slot *s, float *dst, int64_t from, int frames) {
  for (int k = 0; k < frames; k++) dst[k] = s->ring[(from + k) & RING_MASK];
}

/* Crossfades from the old continuation `from` into dst, which already holds the new audio. */
static void splice(const slot *s, float *dst, int64_t from, int frames) {
  int n = frames < XFADE ? frames : XFADE;
  for (int k = 0; k < n; k++) {
    float w = ((float)k + 0.5f) / (float)n;
    dst[k] = s->ring[(from + k) & RING_MASK] * (1.0f - w) + dst[k] * w;
  }
}

static void end_window(render_slot *rs) {
  if (!rs->underrun_in_window) {
    rs->clean += rs->window;
    if (rs->clean >= MARGIN_DECAY_AFTER) {
      rs->clean = 0;
      rs->margin = rs->margin - MARGIN_DECAY < MARGIN_MIN ? MARGIN_MIN : rs->margin - MARGIN_DECAY;
    }
    int64_t next = 0;
    if (rs->lowest - rs->margin > TRIM_MIN) {
      next = rs->lowest - rs->margin;
    } else if (rs->lowest < rs->margin / 2) {
      next = rs->lowest - rs->margin;
      if (next < -INSERT_MAX) next = -INSERT_MAX;
    }
    if (next == 0 || (next > 0) != (rs->pending > 0)) rs->pending_age = 0;
    rs->pending = next;
  } else {
    rs->clean = 0;
    rs->pending = 0;
    rs->pending_age = 0;
  }
  rs->lowest = INT64_MAX;
  rs->window = 0;
  rs->underrun_in_window = 0;
}

static void spliced(render_slot *rs) {
  rs->pending = 0;
  rs->pending_age = 0;
  rs->lowest = INT64_MAX;
  rs->window = 0;
}

static void map_marks(slot *s, render_slot *rs, int64_t frame_index, int64_t base, int64_t end) {
  uint32_t head = atomic_load_explicit(&s->marks_head, memory_order_acquire);
  if (head - rs->marks_tail > MARKS) rs->marks_tail = head - MARKS;
  while (rs->marks_tail != head) {
    push_mark *m = &s->marks[rs->marks_tail % MARKS];
    uint32_t seq = atomic_load_explicit(&m->seq, memory_order_acquire);
    int64_t pos = atomic_load_explicit(&m->pos, memory_order_relaxed);
    int64_t t = atomic_load_explicit(&m->t_ns, memory_order_relaxed);
    atomic_thread_fence(memory_order_acquire);
    if (seq != rs->marks_tail + 1 || atomic_load_explicit(&m->seq, memory_order_relaxed) != seq) {
      rs->marks_tail++;
      continue;
    }
    if (pos - 1 >= end) break;
    rs->marks_tail++;
    int64_t present;
    if (pos - 1 >= base && ao_presentation_ns(frame_index + (pos - 1 - base), &present) == FSV_OK) {
      hist_add(&h_present, (present - t) / 1000);
    }
  }
}

static void map_onset(uint32_t word, int64_t frame_index, int64_t base, int64_t end) {
  int64_t pos_on = atomic_load_explicit(&mon_pos_on, memory_order_relaxed);
  if (pos_on >= end) return;
  int64_t t_on;
  if (ao_presentation_ns(frame_index + (pos_on - base), &t_on) != FSV_OK) return;
  int64_t t_b = atomic_load_explicit(&mon_t_b, memory_order_relaxed);
  atomic_store_explicit(&mon_ms, (float)((double)(t_on - t_b) / 1e6), memory_order_relaxed);
  atomic_compare_exchange_strong(&mon_word, &word, MON_WORD(MON_SERIAL(word), MON_DONE));
}

/* Takes this callback's frames of one slot from its ring into `in`, running the fill servo. */
static void take_slot(int index, slot *s, render_slot *rs, float *in, int n, int64_t frame_index, uint32_t word) {
  uint32_t live = atomic_load_explicit(&s->live, memory_order_acquire);
  int64_t w = atomic_load_explicit(&s->write, memory_order_acquire);
  int64_t r = atomic_load_explicit(&s->read, memory_order_relaxed);
  if (live != rs->live_seen) {
    rs->live_seen = live;
    rs->active = live != 0;
    r = w;
    start_priming(rs, MARGIN_START);
    rs->marks_tail = atomic_load_explicit(&s->marks_head, memory_order_acquire);
    rs->fill_sum = 0;
    rs->fill_n = 0;
    rs->fill_frames = 0;
  }
  int64_t fill = w - r;
  if (fill < 0 || fill > RING_FRAMES) {
    r = w;
    fill = 0;
  }
  if (!rs->active) {
    memset(in, 0, (size_t)n * sizeof(float));
    atomic_store_explicit(&s->read, w, memory_order_release);
    atomic_store_explicit(&s->fill, 0, memory_order_relaxed);
    return;
  }

  rs->fill_sum += fill;
  rs->fill_n++;
  rs->fill_frames += n;
  if (rs->fill_frames >= OUT_METER_FRAMES) {
    atomic_store_explicit(&s->fill, (int)(rs->fill_sum / rs->fill_n - n / 2), memory_order_relaxed);
    rs->fill_sum = 0;
    rs->fill_n = 0;
    rs->fill_frames = 0;
  }

  if (rs->priming) {
    if (fill < n + rs->margin + PRIME_EXTRA + atomic_load_explicit(&s->push_frames, memory_order_relaxed)) {
      memset(in, 0, (size_t)n * sizeof(float));
      atomic_store_explicit(&s->read, r, memory_order_release);
      return;
    }
    rs->priming = 0;
    rs->fade_in = 1;
    rs->lowest = INT64_MAX;
    rs->window = 0;
  }

  int64_t slack = fill - n;
  int64_t to = r;     /* ring position played at frame_index */
  int64_t from = -1;  /* old continuation to crossfade from */
  int64_t hold = 0;   /* frames to replay next callback (an insert) */
  if (rs->insert_next) {
    from = rs->insert_from;
    rs->insert_next = 0;
  } else if (slack > rs->margin + CEILING) {
    int64_t skip = slack - (rs->margin + AFTER_JUMP);
    from = r;
    to = r + skip;
    atomic_fetch_add_explicit(&s->trimmed, skip, memory_order_relaxed);
    spliced(rs);
  } else if (rs->pending != 0) {
    rs->pending_age += n;
    int forced = rs->pending_age >= FORCE_AFTER;
    if (rs->pending > 0) {
      int64_t k = rs->pending;
      if (slack >= k + rs->margin && fill >= k + XFADE && (forced || quiet_span(s, r, k + XFADE))) {
        from = r;
        to = r + k;
        atomic_fetch_add_explicit(&s->trimmed, k, memory_order_relaxed);
        spliced(rs);
      }
    } else {
      int64_t k = -rs->pending;
      if (slack >= XFADE && (forced || quiet_span(s, r + n - k, k + XFADE))) {
        hold = k;
        rs->insert_next = 1;
        rs->insert_from = r + n;
        rs->inserted += k;
        spliced(rs);
      }
    }
  }

  int64_t avail = w - to;
  int played = n;
  if (avail >= n) {
    copy_ring(s, in, to, n);
    if (from >= 0) splice(s, in, from, n);
  } else {
    played = (int)avail;
    copy_ring(s, in, to, played);
    for (int k = 0; k < FADE && k < played; k++) in[played - 1 - k] *= (float)k / FADE;
    memset(in + played, 0, (size_t)(n - played) * sizeof(float));
    atomic_fetch_add_explicit(&s->underruns, 1, memory_order_relaxed);
    int64_t margin = rs->margin + MARGIN_STEP > MARGIN_MAX ? MARGIN_MAX : rs->margin + MARGIN_STEP;
    start_priming(rs, margin);
    rs->underrun_in_window = 1;
    hold = 0;
  }
  if (rs->fade_in) {
    for (int k = 0; k < FADE && k < n; k++) in[k] *= (float)(k + 1) / FADE;
    rs->fade_in = 0;
  }
  atomic_store_explicit(&s->read, to + played - hold, memory_order_release);

  if (!rs->priming) {
    int64_t slack_after = slack - (to - r) + hold;
    if (slack_after < rs->lowest) rs->lowest = slack_after;
    rs->window += n;
    if (rs->window >= WINDOW_FRAMES) end_window(rs);
  }
  atomic_store_explicit(&s->margin, (int)rs->margin, memory_order_relaxed);
  map_marks(s, rs, frame_index, to, to + played);
  if (MON_CODE(word) == MON_FOUND && atomic_load_explicit(&mon_slot, memory_order_relaxed) == index) {
    map_onset(word, frame_index, to, to + played);
  }
}

static void update_notch(render_slot *rs, float hz) {
  float db = rs->notch_db.value;
  if (hz == rs->notch_hz_cur && fabsf(db - rs->notch_db_cur) <= NOTCH_SETTLE_DB) return;
  float z1 = rs->notch.z1, z2 = rs->notch.z2;
  fsv_biquad_peaking(&rs->notch, FS, hz, FSV_FEEDBACK_NOTCH_Q, db);
  rs->notch.z1 = z1;
  rs->notch.z2 = z2;
  rs->notch_hz_cur = hz;
  rs->notch_db_cur = db;
}

/* The slot's output stage (compressor, notch, fader, monitor) into the dry bus, its echo and the reverb send. */
static void run_strip(slot *s, render_slot *rs, float *x, int n, const echo_mix *mix, int measuring) {
  float volume = atomic_load_explicit(&s->volume, memory_order_relaxed);
  float fader = atomic_load_explicit(&s->muted, memory_order_relaxed)
                    ? 0.0f
                    : (atomic_load_explicit(&s->ducked, memory_order_relaxed) ? duck_gain : 1.0f) * volume;
  rs->fader.target = fader;
  rs->monitor.target = atomic_load_explicit(&s->monitor, memory_order_relaxed) && !measuring ? 1.0f : 0.0f;
  float echo = mix->wet * atomic_load_explicit(&s->echo_amount, memory_order_relaxed);
  rs->echo_send.target = echo < FSV_MAX_WET_GAIN ? echo : FSV_MAX_WET_GAIN;
  rs->reverb_send.target = mix->reverb_send;
  rs->notch_db.target = atomic_load_explicit(&s->notch_db, memory_order_relaxed);
  float hz = atomic_load_explicit(&s->notch_hz, memory_order_relaxed);
  if (hz <= 0.0f) hz = NOTCH_REST_HZ;
  fsv_echo_set(rs->echo, mix->feedback, mix->lowpass_hz);

  fsv_compressor_run_mono(rs->comp, x, n);
  for (int k = 0; k < n; k++) {
    if (k % NOTCH_UPDATE == 0) update_notch(rs, hz);
    fsv_ramp_next(&rs->notch_db);
    float v = fsv_biquad_run(&rs->notch, x[k]);
    v *= fsv_ramp_next(&rs->fader);
    v *= fsv_ramp_next(&rs->monitor);
    rs->out_sum += (double)v * v;
    bus_buf[k] += v + fsv_echo_run(rs->echo, v * fsv_ramp_next(&rs->echo_send));
    rev_buf[k] += v * fsv_ramp_next(&rs->reverb_send);
  }
  rs->out_n += n;
  if (rs->out_n >= OUT_METER_FRAMES) {
    atomic_store_explicit(&s->out_rms, (float)sqrt(rs->out_sum / rs->out_n), memory_order_relaxed);
    rs->out_sum = 0.0;
    rs->out_n = 0;
  }
}

static void stream_restarted(void) {
  for (int i = 0; i < FSV_SLOTS; i++) {
    render_slot *rs = &rstate[i];
    rs->live_seen = UINT32_MAX;
  }
  beep_on = 0;
  uint32_t word = atomic_load(&mon_word);
  int code = MON_CODE(word);
  if (code == MON_BEEPING || code == MON_LISTEN || code == MON_FOUND) mon_fail(word, FSV_MONITOR_STOPPED);
}

static uint32_t schedule_beep(uint32_t word, int64_t frame_index, int n) {
  if (MON_CODE(word) == MON_SCHEDULE) {
    uint32_t next = MON_WORD(MON_SERIAL(word), MON_BEEPING);
    if (!atomic_compare_exchange_strong(&mon_word, &word, next)) return word;
    word = next;
    beep_on = 1;
    beep_from = frame_index + BEEP_LEAD;
  }
  if (MON_CODE(word) == MON_BEEPING && frame_index + n > beep_from) {
    int64_t t_b;
    if (ao_presentation_ns(beep_from, &t_b) == FSV_OK) {
      atomic_store_explicit(&mon_t_b, t_b, memory_order_relaxed);
      uint32_t next = MON_WORD(MON_SERIAL(word), MON_LISTEN);
      if (atomic_compare_exchange_strong(&mon_word, &word, next)) word = next;
    }
  }
  return word;
}

static void add_beep(int64_t frame_index, int n) {
  for (int k = 0; k < n; k++) {
    int64_t f = frame_index + k - beep_from;
    if (f < 0 || f >= BEEP_FRAMES) continue;
    float env = FSV_BEEP_GAIN;
    if (f < BEEP_ATTACK) env *= (float)(f + 1) / BEEP_ATTACK;
    if (BEEP_FRAMES - f < BEEP_RELEASE) env *= (float)(BEEP_FRAMES - f) / BEEP_RELEASE;
    float v = env * sinf(TWO_PI * FSV_BEEP_HZ * (float)f / FS);
    left[k] += v;
    right[k] += v;
  }
  if (frame_index + n >= beep_from + BEEP_FRAMES) beep_on = 0;
}

static int16_t to_s16(float v) { return (int16_t)floorf((v < 0.0f ? v * 32768.0f : v * 32767.0f) + 0.5f); }

static void render_piece(int16_t *out, int n, int64_t frame_index) {
  if (frame_index != r_expected) stream_restarted();
  r_expected = frame_index + n;
  echo_mix mix = {
      atomic_load_explicit(&mix_wet, memory_order_relaxed),
      atomic_load_explicit(&mix_feedback, memory_order_relaxed),
      atomic_load_explicit(&mix_lowpass, memory_order_relaxed),
      atomic_load_explicit(&mix_reverb, memory_order_relaxed),
  };
  uint32_t word = schedule_beep(atomic_load_explicit(&mon_word, memory_order_acquire), frame_index, n);

  memset(bus_buf, 0, (size_t)n * sizeof(float));
  memset(rev_buf, 0, (size_t)n * sizeof(float));
  for (int i = 0; i < FSV_SLOTS; i++) {
    slot *s = &slots[i];
    render_slot *rs = &rstate[i];
    if (atomic_exchange_explicit(&s->r_req, 0, memory_order_acq_rel) & REQ_RELEASE) {
      init_render_dsp(rs);
      rs->live_seen = UINT32_MAX;
    }
    if (!atomic_load_explicit(&s->in_use, memory_order_relaxed)) {
      if (rs->live_seen != 0) {
        rs->live_seen = 0;
        rs->active = 0;
      }
      atomic_store_explicit(&s->read, atomic_load_explicit(&s->write, memory_order_acquire), memory_order_release);
      continue;
    }
    take_slot(i, s, rs, in_buf[i], n, frame_index, word);
    run_strip(s, rs, in_buf[i], n, &mix, mon_measuring(word, i));
  }

  memcpy(left, bus_buf, (size_t)n * sizeof(float));
  memcpy(right, bus_buf, (size_t)n * sizeof(float));
  fsv_reverb_run(reverb, rev_buf, left, right, n);
  fsv_compressor_run_stereo(bus_comp, left, right, n);
  if (beep_on) add_beep(frame_index, n);
  fsv_compressor_run_stereo(limiter, left, right, n);

  float peak = 0.0f;
  for (int k = 0; k < n; k++) {
    float l = left[k] * trim_gain, r = right[k] * trim_gain;
    l = l > FSV_VOICE_CEILING ? FSV_VOICE_CEILING : l < -FSV_VOICE_CEILING ? -FSV_VOICE_CEILING : l;
    r = r > FSV_VOICE_CEILING ? FSV_VOICE_CEILING : r < -FSV_VOICE_CEILING ? -FSV_VOICE_CEILING : r;
    out[2 * k] = to_s16(l);
    out[2 * k + 1] = to_s16(r);
    float a = fmaxf(fabsf(l), fabsf(r));
    if (a > peak) peak = a;
  }
  int q15 = (int)(peak * 32768.0f + 0.5f);
  int cur = atomic_load_explicit(&peak_q15, memory_order_relaxed);
  while (q15 > cur && !atomic_compare_exchange_weak_explicit(&peak_q15, &cur, q15, memory_order_relaxed,
                                                              memory_order_relaxed)) {
  }
}

void fsv_render(int16_t *out, int frames, int64_t frame_index) {
  if (frames <= 0) return;
  int64_t t0 = now_ns();
  if (!atomic_load_explicit(&dsp_ready, memory_order_acquire)) {
    memset(out, 0, (size_t)frames * 2 * sizeof(int16_t));
    return;
  }
  while (frames > 0) {
    int n = frames < RENDER_MAX ? frames : RENDER_MAX;
    render_piece(out, n, frame_index);
    out += 2 * n;
    frame_index += n;
    frames -= n;
  }
  hist_add(&h_callback, (now_ns() - t0) / 1000);
  atomic_fetch_add_explicit(&callbacks, 1, memory_order_relaxed);
}

/* ---- Tap drain (D) ---------------------------------------------------------------------------------- */

static uint8_t *put_block(uint8_t *p, int slot_no, int flags, uint32_t seq, const float *samples) {
  uint16_t frames = FSV_TAP_FRAMES;
  p[0] = (uint8_t)slot_no;
  p[1] = (uint8_t)flags;
  memcpy(p + 2, &frames, sizeof(frames));
  memcpy(p + 4, &seq, sizeof(seq));
  if (samples != NULL) memcpy(p + 8, samples, FSV_TAP_FRAMES * sizeof(float));
  else memset(p + 8, 0, FSV_TAP_FRAMES * sizeof(float));
  return p + FSV_TAP_BLOCK_BYTES;
}

static int drain_owned(uint8_t *out, int capacity) {
  int max_blocks = (capacity - 4) / FSV_TAP_BLOCK_BYTES;
  if (max_blocks > FSV_TAP_MAX_BLOCKS) max_blocks = FSV_TAP_MAX_BLOCKS;
  int count = 0;
  uint8_t *p = out + 4;
  for (int k = 0; k < FSV_SLOTS && count < max_blocks; k++) {
    int i = (d_start + k) % FSV_SLOTS;
    slot *s = &slots[i];
    drain_slot *d = &dstate[i];
    int tap_on = atomic_load_explicit(&s->tap, memory_order_relaxed);
    uint32_t tail = atomic_load_explicit(&s->tap_tail, memory_order_relaxed);
    uint32_t head = atomic_load_explicit(&s->tap_head, memory_order_acquire);
    while (tail != head && count < max_blocks) {
      const tap_block *b = &s->taps[tail % TAP_QUEUE];
      uint32_t gap = b->made - d->last_made - 1;
      d->last_made = b->made;
      if (tap_on) {
        uint32_t seq = d->next_seq + gap;
        p = put_block(p, i + 1, 0, seq, b->samples);
        d->next_seq = seq + 1;
        count++;
      }
      tail++;
      atomic_store_explicit(&s->tap_tail, tail, memory_order_release);
    }
    while (tail == head && count < max_blocks) {
      int zeros = atomic_load_explicit(&s->zero_pending, memory_order_relaxed);
      if (zeros <= 0) break;
      if (!atomic_compare_exchange_weak_explicit(&s->zero_pending, &zeros, zeros - 1, memory_order_relaxed,
                                                 memory_order_relaxed)) {
        continue;
      }
      p = put_block(p, i + 1, 1, d->next_seq++, NULL);
      count++;
    }
  }
  d_start = (d_start + 1) % FSV_SLOTS;
  if (count == 0) return 0;
  uint16_t count16 = (uint16_t)count;
  out[0] = 1;
  out[1] = 1;
  memcpy(out + 2, &count16, sizeof(count16));
  int64_t now = now_ns();
  if (d_last_ns != 0) hist_add(&h_drain, (now - d_last_ns) / 1000);
  d_last_ns = now;
  return 4 + count * FSV_TAP_BLOCK_BYTES;
}

int fsv_drain_tap(uint8_t *out, int capacity) {
  if (out == NULL || capacity < 4 + FSV_TAP_BLOCK_BYTES) return 0;
  if (atomic_exchange(&d_busy, 1)) return 0;
  int length = atomic_load(&running) ? drain_owned(out, capacity) : 0;
  atomic_store_explicit(&d_busy, 0, memory_order_release);
  return length;
}

/* ---- Status and statistics (any thread) ------------------------------------------------------------- */

void fsv_slot_status(int slot_no, float out[FSV_STATUS_LEN]) {
  memset(out, 0, FSV_STATUS_LEN * sizeof(float));
  slot *s = slot_at(slot_no);
  if (s == NULL) return;
  int attached = atomic_load(&s->live) != 0;
  out[FSV_STATUS_LEVEL_RMS] = atomic_load(&s->level_rms);
  out[FSV_STATUS_GATE_OPEN] = (float)atomic_load(&s->gate_open);
  out[FSV_STATUS_FEEDBACK_HZ] = atomic_load(&s->feedback_hz);
  out[FSV_STATUS_BOOST_DB] = roundf(atomic_load(&s->boost_db) * 10.0f) / 10.0f;
  out[FSV_STATUS_FILL_MS] = attached ? (float)atomic_load(&s->fill) * 1000.0f / FSV_RATE : 0.0f;
  out[FSV_STATUS_OUT_RMS] = atomic_load(&s->out_rms);
  out[FSV_STATUS_ATTACHED] = (float)attached;
  out[FSV_STATUS_DUCKED_MS] = (float)atomic_load(&s->duck_ms);
}

/* Percentiles (upper bucket edges) of the counts added since `snap`; then `snap` takes the current counts. */
static void hist_window(hist *h, uint32_t *snap, int64_t *p50, int64_t *p95, int64_t *p99, int64_t *max) {
  uint64_t total = 0;
  for (int b = 0; b < HIST_BUCKETS; b++) {
    uint32_t now = atomic_load_explicit(&h->n[b], memory_order_relaxed);
    delta[b] = now - snap[b];
    snap[b] = now;
    total += delta[b];
  }
  int64_t *outs[3] = {p50, p95, p99};
  const uint64_t permille[3] = {500, 950, 990};
  for (int q = 0; q < 3; q++) {
    if (outs[q] == NULL) continue;
    *outs[q] = 0;
    if (total == 0) continue;
    uint64_t target = (total * permille[q] + 999) / 1000;
    uint64_t sum = 0;
    for (int b = 0; b < HIST_BUCKETS; b++) {
      sum += delta[b];
      if (sum >= target) {
        *outs[q] = (int64_t)(b + 1) * HIST_BUCKET_US;
        break;
      }
    }
  }
  int64_t window_max = atomic_exchange_explicit(&h->max_us, 0, memory_order_relaxed);
  if (max != NULL) *max = total == 0 ? 0 : window_max;
}

void fsv_engine_stats(int64_t out[FSV_STATS_LEN]) {
  memset(out, 0, FSV_STATS_LEN * sizeof(int64_t));
  int64_t burst, buffer, xruns, latency, restarts, open;
  ao_stats(&burst, &buffer, &xruns, &latency, &restarts, &open);
  out[FSV_STATS_OPEN] = open;
  out[FSV_STATS_OUTPUT_LATENCY_US] = latency;
  out[FSV_STATS_BURST_FRAMES] = burst;
  out[FSV_STATS_BUFFER_FRAMES] = buffer;
  out[FSV_STATS_XRUNS] = xruns;
  out[FSV_STATS_RESTARTS] = restarts;
  out[FSV_STATS_OPEN_ATTEMPTS] = ao_open_attempts();

  pthread_mutex_lock(&stats_lock);
  int64_t now = now_ns();
  if (window_started_ns == 0 || now - window_started_ns >= STATS_WINDOW_NS) {
    window_started_ns = now;
    hist_window(&h_callback, snap_callback, NULL, NULL, &w_callback_p99, &w_callback_max);
    hist_window(&h_push, snap_push, &w_push_p50, NULL, &w_push_p99, &w_push_max);
    hist_window(&h_present, snap_present, &w_present_p50, &w_present_p95, NULL, NULL);
    hist_window(&h_drain, snap_drain, NULL, NULL, &w_drain_p99, &w_drain_max);
  }
  out[FSV_STATS_CALLBACK_P99_US] = w_callback_p99;
  out[FSV_STATS_CALLBACK_MAX_US] = w_callback_max;
  out[FSV_STATS_PUSH_INTERVAL_P50_US] = w_push_p50;
  out[FSV_STATS_PUSH_INTERVAL_P99_US] = w_push_p99;
  out[FSV_STATS_PUSH_INTERVAL_MAX_US] = w_push_max;
  out[FSV_STATS_PUSH_TO_PRESENT_P50_US] = w_present_p50;
  out[FSV_STATS_PUSH_TO_PRESENT_P95_US] = w_present_p95;
  out[FSV_STATS_TAP_DRAIN_P99_US] = w_drain_p99;
  out[FSV_STATS_TAP_DRAIN_MAX_US] = w_drain_max;
  pthread_mutex_unlock(&stats_lock);

  out[FSV_STATS_TAP_DROPPED] = atomic_load(&tap_dropped);
  out[FSV_STATS_PEAK_Q15] = atomic_exchange(&peak_q15, 0);
  out[FSV_STATS_CALLBACKS] = atomic_load(&callbacks);
  for (int i = 0; i < FSV_SLOTS; i++) {
    int64_t *o = &out[FSV_STATS_SLOT_BASE + FSV_STATS_SLOT_STRIDE * i];
    o[FSV_SLOT_UNDERRUNS] = atomic_load(&slots[i].underruns);
    o[FSV_SLOT_TRIMMED_FRAMES] = atomic_load(&slots[i].trimmed);
    o[FSV_SLOT_MARGIN_FRAMES] = atomic_load(&slots[i].margin);
    o[FSV_SLOT_PUSHED_FRAMES] = atomic_load(&slots[i].pushed);
  }
}
