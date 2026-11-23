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

/* Ring read, in frames: a resampling servo holds each slot's low water (the lowest fill after a callback, per
   window) at LOW_WATER; an underrun is concealed and the ring resumes where the late audio would have played. */
#define LOW_WATER 240          /* 5 ms */
#define SERVO_CALLBACKS 25     /* callbacks per low-water window, about 200 ms */
#define SERVO_SMOOTH 0.5       /* one-pole weight of each window's error */
#define SERVO_GAIN 1.0e-5      /* ratio deviation per frame of smoothed error */
#define RATIO_SPAN 0.005       /* |ratio - 1| at most: 8.7 cents */
#define RATIO_SLEW 0.0005      /* ratio change per callback at most, ramped across it */
#define BACKLOG_MAX 2880       /* 60 ms over the low water: an aligned resync */
#define AHEAD 2                /* the cubic reads two frames past the read position */
#define BEHIND 1               /* and one before it */
#define XFADE 120              /* 2.5 ms: resume and resync cross-fades */
#define ALIGN_MAX 240          /* 5 ms: the resume and resync search on either side */
#define FADE 48                /* 1 ms in after priming, and out at an underrun without concealment */

/* Concealment from the slot's own last output (FSV_CONCEAL 0: an underrun fades out to silence instead). */
#ifndef FSV_CONCEAL
#define FSV_CONCEAL 1
#endif
#define HIST_FRAMES 2048       /* the slot's recent output, a power of two */
#define HIST_MASK (HIST_FRAMES - 1)
#define PLC_DECIMATE 4
#define PLC_WINDOW 128         /* decimated: the last 512 frames */
#define PLC_LAG_MIN 12         /* decimated: periods of 48-720 frames */
#define PLC_LAG_MAX 180
#define PLC_REFINE 480         /* frames compared at full rate, within one decimated step */
#define PLC_PEAK 0.9f          /* the first local peak at this share of the best correlation */
#define PLC_VOICED 0.4f
#define PLC_PERIOD_MAX 1024
#define PLC_HOLD 1920          /* voiced: 40 ms at full level, */
#define PLC_FADE 2880          /* then 60 ms down to silence */
#define PLC_UNVOICED_PERIOD 480
#define PLC_UNVOICED_HOLD 480
#define PLC_UNVOICED_FADE 960

/* Event thresholds for the counters, and the shortest interval between two log lines of a kind. */
#define PUSH_GAP_NS NS_MS(20)
#define SLOW_CALLBACK_NS NS_MS(2)
#define SLOW_DRAIN_NS NS_MS(25)
#define OUTPUT_STALL_NS NS_MS(40)
#define LOG_EVERY_NS NS_MS(1000)

/* Monitor beep. */
#define BEEP_FRAMES (FSV_BEEP_MS * FSV_RATE / 1000)
#define BEEP_ATTACK (FSV_BEEP_ATTACK_MS * FSV_RATE / 1000)
#define BEEP_RELEASE (FSV_BEEP_RELEASE_MS * FSV_RATE / 1000)
#define BEEP_LEAD (FSV_BEEP_LEAD_MS * FSV_RATE / 1000)
#define BEEP_BASELINE (FSV_BEEP_BASELINE_MS * FSV_RATE / 1000)
#define MON_HIST 1024 /* the crossing hop, a window to walk back over and the window before it: 640 */
#define MON_MASK (MON_HIST - 1)
#define MON_REFINE_STEP 16
#define TONE_FLOOR 0.0005f /* latency-test.ts threshold floor, with 3 x mean and 1.5 x peak */
#define LISTEN_AFTER_NS NS_MS(20)
#define LEVEL_HOLD_NS NS_MS(400) /* after a measurement: the returning beep, its last meter block and a margin */

#define NOTCH_REST_HZ 350.0f      /* BiquadFilterNode default frequency */
#define NOTCH_SETTLE_DB 0.0017f   /* a 1e-4 relative change of the peaking amplitude */
#define NOTCH_UPDATE 32

/* Statistics: 100 us buckets. */
#define HIST_BUCKET_US 100
#define HIST_BUCKETS 2500 /* 0-250 ms; the last bucket holds everything above */
#define STATS_WINDOW_NS NS_MS(900) /* the shortest window: a read sooner repeats the last one */

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
  _Atomic int64_t pos; /* ring position of the push's first frame */
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
  _Atomic uint32_t made;     /* P: blocks completed, as push_state.made */
  _Atomic uint64_t zeros;    /* C: (made when the generation ended << 32) | zero blocks still to send */
  tap_block taps[TAP_QUEUE];

  _Atomic int64_t an_w, an_reserve; /* gate output for G, behind a seqlock */
  _Atomic float an[ANALYSIS];
  _Atomic int64_t pushed;

  _Atomic float level_rms; /* P */
  _Atomic int gate_open;
  _Atomic float boost_db; /* G */
  _Atomic float feedback_hz, notch_hz, notch_db;
  _Atomic int ducked, duck_ms;
  _Atomic int fill, low_water; /* R */
  _Atomic float out_rms;
  _Atomic int64_t underruns, dropped;
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
  float base_mean, base_peak, threshold;
  int base_n;
  float window[FSV_BEEP_WINDOW];
} push_state;

typedef struct {
  uint32_t live_seen;
  int active, priming, fade_in;
  int64_t ip;   /* the read position: a ring frame */
  float frac;   /* and the fraction past it, 0 to 1 */
  double ratio, ratio_target, err; /* ring frames per output frame now, the servo's aim, its smoothed error */
  int64_t low_min;
  int low_n;
  int gap;      /* the ring ran dry: concealing, then silent, until the resume */
  int64_t lost, gap_out; /* where it ran dry, and the output frames since */
  int64_t drop_from, drop_to; /* the latest span of late audio skipped */
  int resume_xf;
  float xf_buf[XFADE];
  float hist[HIST_FRAMES]; /* the slot's own output before its strip */
  int64_t hist_w;
  float plc_buf[PLC_PERIOD_MAX];
  int plc_period, plc_i, plc_n, plc_voiced;
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
} render_slot;

typedef struct {
  fsv_level level;
  fsv_tracker tracker;
  int64_t last;
  double now_ms, ducked_until;
  int64_t idle_ns, hold_until_ns;
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
static int64_t r_expected, cb_next_index, cb_last_ns;
static int beep_on;
static int64_t beep_from;
static float in_buf[FSV_SLOTS][RENDER_MAX], bus_buf[RENDER_MAX], rev_buf[RENDER_MAX], left[RENDER_MAX],
    right[RENDER_MAX], synth[RENDER_MAX];
static float plc_dec[PLC_WINDOW + PLC_LAG_MAX], plc_ncc[PLC_LAG_MAX + 1];

/* G */
static float g_x[FSV_GUARD_FFT_SIZE], g_spectrum[FSV_GUARD_FFT_SIZE / 2], g_scratch[2 * FSV_GUARD_FFT_SIZE];
static int g_format_logged;
static int64_t g_format_errors_logged;

/* D */
static int d_start;
static int64_t d_last_ns;

/* fsv-clock */
static int64_t c_stalls_logged, c_stall_logged_ns;

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
static _Atomic int64_t conceals, resyncs, concealed_frames, silent_frames, clamp_hits; /* R */
static _Atomic int64_t output_stalls, last_stall_us, callbacks_over_2ms;            /* R */
static _Atomic int64_t ratio_lo_ppm, ratio_hi_ppm, longest_gap_us, busy_ns, cb_gap_max_us; /* R, per window */
static _Atomic int64_t push_gaps, push_intervals, push_gap_logged_ns;               /* P */
static _Atomic int64_t drains, drains_over_25ms;                                    /* D */
static _Atomic int peak_q15;
static pthread_mutex_t stats_lock = PTHREAD_MUTEX_INITIALIZER;
static uint32_t snap_callback[HIST_BUCKETS], snap_push[HIST_BUCKETS], snap_present[HIST_BUCKETS],
    snap_drain[HIST_BUCKETS];
static uint32_t delta[HIST_BUCKETS];
static int64_t window_started_ns;
static int64_t w_callback_p99, w_callback_max, w_push_p50, w_push_p99, w_push_max, w_present_p50, w_present_p95,
    w_drain_p99, w_drain_max, w_ratio_min, w_ratio_max, w_longest_gap, w_busy_permille, w_gap_max;

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

static void min_update(_Atomic int64_t *min, int64_t value) {
  int64_t cur = atomic_load_explicit(min, memory_order_relaxed);
  while (value < cur && !atomic_compare_exchange_weak_explicit(min, &cur, value, memory_order_relaxed,
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

/* A new generation plays from the write position once its ring holds a callback, the low water and a push. */
static void start_priming(slot *s, render_slot *rs, int64_t w) {
  rs->priming = 1;
  rs->fade_in = 0;
  rs->ip = w;
  rs->frac = 0.0f;
  rs->ratio = rs->ratio_target = 1.0;
  rs->err = 0.0;
  rs->low_min = INT64_MAX;
  rs->low_n = 0;
  rs->gap = 0;
  rs->drop_from = rs->drop_to = 0;
  rs->resume_xf = 0;
  memset(rs->hist, 0, sizeof(rs->hist));
  rs->hist_w = 0;
  atomic_store_explicit(&s->low_water, 0, memory_order_relaxed);
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
    atomic_store(&s->made, 0);
    atomic_store(&s->zeros, 0);
    atomic_store(&s->an_w, 0);
    atomic_store(&s->an_reserve, 0);
    for (int k = 0; k < ANALYSIS; k++) atomic_store_explicit(&s->an[k], 0.0f, memory_order_relaxed);
    atomic_store(&s->pushed, 0);
    atomic_store(&s->level_rms, 0.0f);
    atomic_store(&s->gate_open, 0);
    atomic_store(&s->boost_db, FSV_VOICE_START_BOOST_DB);
    atomic_store(&s->notch_hz, 0.0f);
    atomic_store(&s->fill, 0);
    atomic_store(&s->low_water, 0);
    atomic_store(&s->out_rms, 0.0f);
    atomic_store(&s->underruns, 0);
    atomic_store(&s->dropped, 0);

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
  cb_next_index = -1;
  cb_last_ns = 0;
  c_stalls_logged = 0;
  c_stall_logged_ns = 0;
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
  atomic_store(&conceals, 0);
  atomic_store(&resyncs, 0);
  atomic_store(&concealed_frames, 0);
  atomic_store(&silent_frames, 0);
  atomic_store(&clamp_hits, 0);
  atomic_store(&output_stalls, 0);
  atomic_store(&last_stall_us, 0);
  atomic_store(&callbacks_over_2ms, 0);
  atomic_store(&ratio_lo_ppm, INT64_MAX);
  atomic_store(&ratio_hi_ppm, INT64_MIN);
  atomic_store(&longest_gap_us, 0);
  atomic_store(&busy_ns, 0);
  atomic_store(&cb_gap_max_us, 0);
  atomic_store(&push_gaps, 0);
  atomic_store(&push_intervals, 0);
  atomic_store(&push_gap_logged_ns, 0);
  atomic_store(&drains, 0);
  atomic_store(&drains_over_25ms, 0);
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

/* One guard step for a slot, every 2400 pushed frames (mic-rack.ts guard and levelVoice). The auto
   level skips the steps that would hear the engine's own monitor beep: web has no such beep. */
static void guard_tick(int index, slot *s, guard_slot *gs, int64_t now) {
  gs->now_ms += 1000.0 * FSV_GUARD_FRAMES / FSV_RATE;
  float elapsed = gs->first ? 0.0f : (float)FSV_GUARD_FRAMES / FSV_RATE;
  gs->first = 0;
  if (now >= gs->hold_until_ns &&
      fsv_level_step(&gs->level, atomic_load(&s->level_rms), atomic_load(&s->gate_open), elapsed)) {
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

/* With no audio the guard's clock stops, but a duck still runs out in wall-clock time, as MicRack's
   guard timer keeps running for a detached strip. */
static void idle_duck(slot *s, guard_slot *gs, int64_t now) {
  if (gs->ducked_until != 0.0 && gs->idle_ns != 0) {
    gs->now_ms += (double)(now - gs->idle_ns) / 1e6;
    if (gs->now_ms >= gs->ducked_until) reset_duck(s, gs);
    else atomic_store(&s->duck_ms, (int)(gs->ducked_until - gs->now_ms));
  }
  gs->idle_ns = now;
}

static void guard_slot_step(int index) {
  slot *s = &slots[index];
  guard_slot *gs = &gstate[index];
  int64_t now = now_ns();
  uint32_t req = atomic_exchange(&s->g_req, 0);
  if (req & REQ_RELEASE) {
    fsv_level_init(&gs->level);
    gs->first = 1;
    publish_boost(s, gs);
    reset_duck(s, gs);
  }
  if (req & (REQ_RELEASE | REQ_DETACH | REQ_MONITOR_OFF)) fsv_tracker_reset(&gs->tracker);
  if (mon_measuring(atomic_load(&mon_word), index)) gs->hold_until_ns = now + LEVEL_HOLD_NS;
  int64_t pushed = atomic_load(&s->pushed);
  if (atomic_load(&s->live) == 0) {
    gs->last = pushed;
    idle_duck(s, gs, now);
    return;
  }
  gs->idle_ns = 0;
  for (int n = 0; pushed - gs->last >= FSV_GUARD_FRAMES; n++) {
    if (n == 4) {
      gs->last = pushed - (pushed - gs->last) % FSV_GUARD_FRAMES;
      break;
    }
    guard_tick(index, s, gs, now);
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

/* Ends the slot's generation. Waiting out a push that is still running makes `made` count every block
   of it, so the zero blocks sent for a detach follow its audio and precede the next generation's. */
static void end_generation(slot *s) {
  int tap_on = atomic_load(&s->want) != 0 && atomic_load(&s->tap);
  atomic_store(&s->want, 0);
  atomic_store(&s->live, 0);
  if (!tap_on) return;
  while (atomic_load(&s->busy)) sched_yield();
  atomic_store(&s->zeros, ((uint64_t)atomic_load(&s->made) << 32) | ZERO_BLOCKS);
}

static void release_locked(int index) {
  slot *s = &slots[index];
  end_generation(s);
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
    end_generation(s);
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
        if (value == 0.0f) atomic_store(&s->zeros, 0);
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

/* The ring position where the tone starts. A window's amplitude grows with the tone samples it holds, so
   it reaches the threshold about window * threshold / amplitude samples into the tone. From the first window
   end at or above the threshold (to 16 samples, in the hop that crossed), the onset is extrapolated back
   along the rising edge: step back while the amplitude keeps falling and stays above the baseline's
   peak, then follow the line through both ends down to the baseline's mean. */
static int64_t onset_pos(push_state *ps, float amp) {
  int64_t cross = ps->mon_n;
  float a_cross = amp;
  for (int64_t end = ps->mon_n - FSV_BEEP_HOP + MON_REFINE_STEP; end < ps->mon_n; end += MON_REFINE_STEP) {
    float a = goertzel_at(ps, end);
    if (a >= ps->threshold) {
      cross = end;
      a_cross = a;
      break;
    }
  }
  int64_t edge = cross;
  float a_edge = a_cross;
  while (cross - edge < FSV_BEEP_WINDOW) {
    float a = goertzel_at(ps, edge - MON_REFINE_STEP);
    if (a <= ps->base_peak || a >= a_edge) break;
    edge -= MON_REFINE_STEP;
    a_edge = a;
  }
  int64_t back = MON_REFINE_STEP / 2;
  if (edge != cross) {
    float x = (a_cross - ps->base_mean) * (float)(cross - edge) / (a_cross - a_edge);
    back = x < FSV_BEEP_WINDOW ? (int64_t)lroundf(x) : FSV_BEEP_WINDOW;
  }
  return ps->mon_pos[(cross - back) & MON_MASK];
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
      ps->base_mean = (float)(ps->base_sum / ps->base_n);
      ps->threshold = fmaxf(TONE_FLOOR, fmaxf(3.0f * ps->base_mean, 1.5f * ps->base_peak));
      uint32_t next = MON_WORD(MON_SERIAL(word), MON_SCHEDULE);
      return atomic_compare_exchange_strong(&mon_word, &word, next) ? next : 0;
    }
  } else if (code == MON_LISTEN) {
    int64_t t_b = atomic_load_explicit(&mon_t_b, memory_order_relaxed);
    if (t_push > t_b + NS_MS(FSV_BEEP_TIMEOUT_MS)) {
      mon_fail(word, FSV_MONITOR_NO_TONE);
      return 0;
    }
    float amp = t_push >= t_b + LISTEN_AFTER_NS ? goertzel_at(ps, ps->mon_n) : 0.0f;
    if (amp >= ps->threshold) {
      int64_t pos = onset_pos(ps, amp);
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

/* Counts a push interval; one over 20 ms is logged, at most once a second across the slots. */
static void note_push_interval(int index, int64_t t, int64_t interval) {
  atomic_fetch_add_explicit(&push_intervals, 1, memory_order_relaxed);
  if (interval <= PUSH_GAP_NS) return;
  atomic_fetch_add_explicit(&push_gaps, 1, memory_order_relaxed);
  int64_t logged = atomic_load_explicit(&push_gap_logged_ns, memory_order_relaxed);
  if (t - logged >= LOG_EVERY_NS && atomic_compare_exchange_strong(&push_gap_logged_ns, &logged, t)) {
    LOGW("fsv: push gap %d ms slot %d", (int)(interval / 1000000), index + 1);
  }
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
  if (ps->last_push_ns != 0) {
    hist_add(&h_push, (t - ps->last_push_ns) / 1000);
    note_push_interval(index, t, t - ps->last_push_ns);
  }
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
    put_mark(s, ps, w, t);
  }
  atomic_fetch_add_explicit(&s->pushed, frames, memory_order_relaxed);
  atomic_store_explicit(&s->made, ps->made, memory_order_relaxed);
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

static float cubic_at(const float *ring, int64_t ip, float f) {
  float xm = ring[(ip - 1) & RING_MASK], x0 = ring[ip & RING_MASK], x1 = ring[(ip + 1) & RING_MASK],
        x2 = ring[(ip + 2) & RING_MASK];
  float c1 = 0.5f * (x1 - xm);
  float c2 = xm - 2.5f * x0 + 2.0f * x1 - 0.5f * x2;
  float c3 = 0.5f * (x2 - xm) + 1.5f * (x0 - x1);
  return ((c3 * f + c2) * f + c1) * f + x0;
}

static void hist_put(render_slot *rs, const float *x, int n) {
  for (int k = 0; k < n; k++) rs->hist[(rs->hist_w + k) & HIST_MASK] = x[k];
  rs->hist_w += n;
}

static float hist_at(const render_slot *rs, int64_t back) { return rs->hist[(rs->hist_w - back) & HIST_MASK]; }

/* The pitch period of the slot's recent output: the normalised autocorrelation of the last 512 frames, 4x
   decimated, takes the first local peak near the best, then a search at full rate around it. */
static int plc_period(const render_slot *rs, float *ncc_out) {
  const int nd = PLC_WINDOW + PLC_LAG_MAX;
  for (int t = 0; t < nd; t++) {
    int64_t back = (int64_t)(nd - t) * PLC_DECIMATE;
    plc_dec[t] = 0.25f * (hist_at(rs, back) + hist_at(rs, back - 1) + hist_at(rs, back - 2) + hist_at(rs, back - 3));
  }
  float e0 = 0.0f, best = -2.0f;
  for (int t = PLC_LAG_MAX; t < nd; t++) e0 += plc_dec[t] * plc_dec[t];
  for (int lag = PLC_LAG_MIN; lag <= PLC_LAG_MAX; lag++) {
    float xy = 0.0f, e1 = 0.0f;
    for (int t = PLC_LAG_MAX; t < nd; t++) {
      xy += plc_dec[t] * plc_dec[t - lag];
      e1 += plc_dec[t - lag] * plc_dec[t - lag];
    }
    plc_ncc[lag] = xy / sqrtf(e0 * e1 + 1e-12f);
    if (plc_ncc[lag] > best) best = plc_ncc[lag];
  }
  int pick = PLC_LAG_MIN;
  for (int lag = PLC_LAG_MIN + 1; lag < PLC_LAG_MAX; lag++) {
    if (plc_ncc[lag] >= PLC_PEAK * best && plc_ncc[lag] >= plc_ncc[lag - 1] && plc_ncc[lag] >= plc_ncc[lag + 1]) {
      pick = lag;
      break;
    }
  }
  int period = pick * PLC_DECIMATE;
  float best_full = -2.0f;
  for (int p = (pick - 1) * PLC_DECIMATE; p <= (pick + 1) * PLC_DECIMATE; p++) {
    float xy = 0.0f, a = 0.0f, b = 0.0f;
    for (int t = 1; t <= PLC_REFINE; t++) {
      float x = hist_at(rs, t), y = hist_at(rs, t + p);
      xy += x * y;
      a += x * x;
      b += y * y;
    }
    float c = xy / sqrtf(a * b + 1e-12f);
    if (c > best_full) {
      best_full = c;
      period = p;
    }
  }
  *ncc_out = best_full;
  return period;
}

/* The loop to conceal with: the last period, its last quarter cross-faded toward the period before it. */
static void plc_start(render_slot *rs) {
  float ncc;
  int period = plc_period(rs, &ncc);
  rs->plc_voiced = ncc >= PLC_VOICED;
  if (!rs->plc_voiced) period = PLC_UNVOICED_PERIOD;
  if (period > PLC_PERIOD_MAX) period = PLC_PERIOD_MAX;
  rs->plc_period = period;
  int x = period / 4;
  for (int i = 0; i < period; i++) {
    float v = hist_at(rs, period - i);
    if (i >= period - x) {
      float w = ((float)(i - (period - x)) + 0.5f) / (float)x;
      v = v * (1.0f - w) + hist_at(rs, 2 * period - i) * w;
    }
    rs->plc_buf[i] = v;
  }
  rs->plc_i = 0;
  rs->plc_n = 0;
}

static int plc_end(const render_slot *rs) {
  return rs->plc_voiced ? PLC_HOLD + PLC_FADE : PLC_UNVOICED_HOLD + PLC_UNVOICED_FADE;
}

static float plc_next(render_slot *rs) {
  float v = rs->plc_buf[rs->plc_i];
  rs->plc_i = rs->plc_i + 1 == rs->plc_period ? 0 : rs->plc_i + 1;
  int hold = rs->plc_voiced ? PLC_HOLD : PLC_UNVOICED_HOLD;
  int fade = rs->plc_voiced ? PLC_FADE : PLC_UNVOICED_FADE;
  float g = rs->plc_n < hold ? 1.0f : rs->plc_n < hold + fade ? 1.0f - (float)(rs->plc_n - hold) / (float)fade : 0.0f;
  rs->plc_n++;
  return v * g;
}

/* Output while the ring is dry: the concealment, then silence once it has faded out. */
static void conceal_into(render_slot *rs, float *dst, int count) {
  int64_t concealed = 0;
  for (int k = 0; k < count; k++) {
    if (FSV_CONCEAL && rs->plc_n < plc_end(rs)) {
      dst[k] = plc_next(rs);
      concealed++;
    } else {
      dst[k] = 0.0f;
    }
  }
  if (concealed > 0) atomic_fetch_add_explicit(&concealed_frames, concealed, memory_order_relaxed);
  if (concealed < count) atomic_fetch_add_explicit(&silent_frames, count - concealed, memory_order_relaxed);
}

/* The ring position within [pos + lo, pos + hi] whose next XFADE frames best continue `from` (the normalised
   correlation), kept inside what the ring holds. */
static int64_t align(const slot *s, int64_t pos, int lo, int hi, const float *from, int64_t w) {
  if (pos + hi + XFADE > w) hi = (int)(w - XFADE - pos);
  int64_t best_pos = pos;
  float best = -1e30f;
  for (int d = lo; d <= hi; d++) {
    float xy = 0.0f, e = 1e-12f;
    for (int k = 0; k < XFADE; k++) {
      float y = s->ring[(pos + d + k) & RING_MASK];
      xy += from[k] * y;
      e += y * y;
    }
    float c = xy / sqrtf(e);
    if (c > best) {
      best = c;
      best_pos = pos + d;
    }
  }
  return best_pos;
}

static void skip_to(slot *s, render_slot *rs, int64_t from, int64_t to) {
  rs->ip = to;
  rs->frac = 0.0f;
  if (to <= from) return;
  atomic_fetch_add_explicit(&s->dropped, to - from, memory_order_relaxed);
  rs->drop_from = from;
  rs->drop_to = to;
}

/* Ends a dry spell at the position the late audio would be playing now, aligned to the concealment and
   cross-faded from it; without concealment left, a fade-in from silence. */
static void resume(slot *s, render_slot *rs, int64_t at, int64_t w, int n) {
  int xf = FSV_CONCEAL && rs->plc_n < plc_end(rs) ? XFADE : 0;
  for (int k = 0; k < xf; k++) synth[k] = plc_next(rs);
  if (xf > 0) {
    int half = rs->plc_period / 2 < ALIGN_MAX ? rs->plc_period / 2 : ALIGN_MAX;
    at = align(s, at, -half, half, synth, w);
    if (at < rs->lost) at = rs->lost;
    if (w - at < n + AHEAD) at = w - (n + AHEAD);
  }
  max_update(&longest_gap_us, rs->gap_out * 1000000 / FSV_RATE);
  skip_to(s, rs, rs->lost, at);
  rs->resume_xf = xf;
  memcpy(rs->xf_buf, synth, (size_t)xf * sizeof(float));
  rs->fade_in = xf == 0;
  rs->gap = 0;
  rs->err = 0.0;
  rs->low_min = INT64_MAX;
  rs->low_n = 0;
}

/* A backlog far over the low water (the output stopped pulling): back to it, aligned and cross-faded. */
static void resync(slot *s, render_slot *rs, int64_t w, int n, int push) {
  if (rs->resume_xf == 0) {
    for (int k = 0; k < XFADE; k++) rs->xf_buf[k] = s->ring[(rs->ip + k) & RING_MASK];
  }
  int64_t at = align(s, w - (n + LOW_WATER + push / 2), -ALIGN_MAX, ALIGN_MAX, rs->xf_buf, w);
  atomic_fetch_add_explicit(&resyncs, 1, memory_order_relaxed);
  skip_to(s, rs, rs->ip, at);
  rs->resume_xf = XFADE;
  rs->err = 0.0;
  rs->ratio = rs->ratio_target = 1.0;
}

static void servo_window(slot *s, render_slot *rs) {
  atomic_store_explicit(&s->low_water, (int)rs->low_min, memory_order_relaxed);
  rs->err += SERVO_SMOOTH * ((double)(rs->low_min - LOW_WATER) - rs->err);
  double dev = SERVO_GAIN * rs->err;
  rs->ratio_target = 1.0 + (dev > RATIO_SPAN ? RATIO_SPAN : dev < -RATIO_SPAN ? -RATIO_SPAN : dev);
  rs->low_min = INT64_MAX;
  rs->low_n = 0;
}

/* Output frame of a ring position, through this callback's mean ratio: frame_index for `start`. */
static int64_t frame_of(int64_t pos, int64_t frame_index, double start, double step) {
  return frame_index + (int64_t)floor(((double)pos - start) / step + 0.5);
}

/* Push-to-present for the marks played this callback; a mark in skipped audio is passed over. */
static void map_marks(slot *s, render_slot *rs, int64_t frame_index, double start, double end, double step) {
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
    if ((double)pos >= end) break;
    rs->marks_tail++;
    int64_t present;
    if ((double)pos >= start && ao_presentation_ns(frame_of(pos, frame_index, start, step), &present) == FSV_OK) {
      hist_add(&h_present, (present - t) / 1000);
    }
  }
}

/* The beep's onset, found by P, to its presentation time: once played (earlier ones map back through this
   callback's ratio), or a failure when it fell in skipped audio. */
static void map_onset(const render_slot *rs, uint32_t word, int64_t frame_index, double start, double end,
                      double step) {
  int64_t pos_on = atomic_load_explicit(&mon_pos_on, memory_order_relaxed);
  if ((double)pos_on >= end) return;
  if (pos_on >= rs->drop_from && pos_on < rs->drop_to) {
    mon_fail(word, FSV_MONITOR_STOPPED);
    return;
  }
  int64_t t_on;
  if (ao_presentation_ns(frame_of(pos_on, frame_index, start, step), &t_on) != FSV_OK) return;
  int64_t t_b = atomic_load_explicit(&mon_t_b, memory_order_relaxed);
  atomic_store_explicit(&mon_ms, (float)((double)(t_on - t_b) / 1e6), memory_order_relaxed);
  atomic_compare_exchange_strong(&mon_word, &word, MON_WORD(MON_SERIAL(word), MON_DONE));
}

/* Takes this callback's frames of one slot from its ring into `in`: a resampling read servoed to the low
   water, a concealment while the ring is dry, and a resume on time after it. */
static void take_slot(int index, slot *s, render_slot *rs, float *in, int n, int64_t frame_index, uint32_t word) {
  uint32_t live = atomic_load_explicit(&s->live, memory_order_acquire);
  int64_t w = atomic_load_explicit(&s->write, memory_order_acquire);
  if (live != rs->live_seen) {
    rs->live_seen = live;
    rs->active = live != 0;
    start_priming(s, rs, w);
    rs->marks_tail = atomic_load_explicit(&s->marks_head, memory_order_acquire);
    rs->fill_sum = 0;
    rs->fill_n = 0;
    rs->fill_frames = 0;
  }
  double fill = (double)(w - rs->ip) - rs->frac;
  if (fill < 0.0 || fill > RING_FRAMES - 4) {
    rs->ip = w;
    rs->frac = 0.0f;
    fill = 0.0;
  }
  if (!rs->active) {
    memset(in, 0, (size_t)n * sizeof(float));
    atomic_store_explicit(&s->read, w, memory_order_release);
    atomic_store_explicit(&s->fill, 0, memory_order_relaxed);
    return;
  }

  rs->fill_sum += (int64_t)fill;
  rs->fill_n++;
  rs->fill_frames += n;
  if (rs->fill_frames >= OUT_METER_FRAMES) {
    atomic_store_explicit(&s->fill, (int)(rs->fill_sum / rs->fill_n - n / 2), memory_order_relaxed);
    rs->fill_sum = 0;
    rs->fill_n = 0;
    rs->fill_frames = 0;
  }

  int push = atomic_load_explicit(&s->push_frames, memory_order_relaxed);
  if (rs->priming) {
    if (fill < n + AHEAD + LOW_WATER + push) {
      memset(in, 0, (size_t)n * sizeof(float));
      atomic_store_explicit(&s->read, rs->ip - BEHIND, memory_order_release);
      return;
    }
    rs->priming = 0;
    rs->fade_in = 1;
    rs->low_min = INT64_MAX;
    rs->low_n = 0;
  }

  if (rs->gap) {
    int64_t need = n + AHEAD + LOW_WATER + push / 2;
    int64_t at = rs->lost + rs->gap_out;
    if (w - at < need) at = w - need;
    if (at < rs->lost) at = rs->lost;
    if (w - at < need) {
      conceal_into(rs, in, n);
      hist_put(rs, in, n);
      rs->gap_out += n;
      int64_t keep = at - ALIGN_MAX - BEHIND;
      atomic_store_explicit(&s->read, keep > rs->lost - BEHIND ? keep : rs->lost - BEHIND, memory_order_release);
      return;
    }
    resume(s, rs, at, w, n);
    fill = (double)(w - rs->ip);
  }
  if (fill - n - LOW_WATER > BACKLOG_MAX) resync(s, rs, w, n, push);

  double rho0 = rs->ratio;
  double rho1 = rs->ratio_target;
  if (rho1 > rho0 + RATIO_SLEW) rho1 = rho0 + RATIO_SLEW;
  if (rho1 < rho0 - RATIO_SLEW) rho1 = rho0 - RATIO_SLEW;
  int64_t ip = rs->ip;
  float fr = rs->frac;
  double start = (double)ip + fr;
  float rr = (float)rho0, drr = (float)((rho1 - rho0) / n);
  int k = 0;
  for (; k < n && ip + AHEAD < w; k++) {
    in[k] = cubic_at(s->ring, ip, fr);
    rr += drr;
    fr += rr;
    while (fr >= 1.0f) {
      fr -= 1.0f;
      ip++;
    }
  }
  double end = (double)ip + fr;
  rs->ip = ip;
  rs->frac = fr;
  rs->ratio = rho1;
  if (rs->resume_xf > 0) {
    int xf = rs->resume_xf < k ? rs->resume_xf : k;
    for (int j = 0; j < xf; j++) {
      float wgt = ((float)j + 0.5f) / (float)xf;
      in[j] = rs->xf_buf[j] * (1.0f - wgt) + in[j] * wgt;
    }
    rs->resume_xf = 0;
  }
  if (rs->fade_in) {
    for (int j = 0; j < FADE && j < k; j++) in[j] *= (float)(j + 1) / FADE;
    rs->fade_in = 0;
  }

  if (k < n) {
    atomic_fetch_add_explicit(&s->underruns, 1, memory_order_relaxed);
    atomic_fetch_add_explicit(&conceals, 1, memory_order_relaxed);
    rs->gap = 1;
    rs->lost = ip;
    rs->gap_out = n - k;
    if (FSV_CONCEAL) {
      hist_put(rs, in, k);
      plc_start(rs);
      conceal_into(rs, in + k, n - k);
      hist_put(rs, in + k, n - k);
    } else {
      for (int j = 0; j < FADE && j < k; j++) in[k - 1 - j] *= (float)j / FADE;
      conceal_into(rs, in + k, n - k);
      hist_put(rs, in, n);
    }
  } else {
    hist_put(rs, in, n);
    double low = (double)(w - ip) - fr - AHEAD;
    if (low < (double)rs->low_min) rs->low_min = (int64_t)low;
    if (++rs->low_n >= SERVO_CALLBACKS) servo_window(s, rs);
  }
  atomic_store_explicit(&s->read, ip - BEHIND, memory_order_release);
  if (k == 0) return;
  double step = (end - start) / k;
  map_marks(s, rs, frame_index, start, end, step);
  if (MON_CODE(word) == MON_FOUND && atomic_load_explicit(&mon_slot, memory_order_relaxed) == index) {
    map_onset(rs, word, frame_index, start, end, step);
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
  int64_t ratio_lo = INT64_MAX, ratio_hi = INT64_MIN;
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
    if (rs->active && !rs->priming && !rs->gap) {
      int64_t ppm = (int64_t)floor((rs->ratio - 1.0) * 1e6 + 0.5);
      if (ppm < ratio_lo) ratio_lo = ppm;
      if (ppm > ratio_hi) ratio_hi = ppm;
    }
  }
  if (ratio_hi != INT64_MIN) {
    min_update(&ratio_lo_ppm, ratio_lo);
    max_update(&ratio_hi_ppm, ratio_hi);
  }

  memcpy(left, bus_buf, (size_t)n * sizeof(float));
  memcpy(right, bus_buf, (size_t)n * sizeof(float));
  fsv_reverb_run(reverb, rev_buf, left, right, n);
  fsv_compressor_run_stereo(bus_comp, left, right, n);
  if (beep_on) add_beep(frame_index, n);
  fsv_compressor_run_stereo(limiter, left, right, n);

  float peak = 0.0f;
  int clamped = 0;
  for (int k = 0; k < n; k++) {
    float l = left[k] * trim_gain, r = right[k] * trim_gain;
    if (fabsf(l) > FSV_VOICE_CEILING || fabsf(r) > FSV_VOICE_CEILING) clamped++;
    l = l > FSV_VOICE_CEILING ? FSV_VOICE_CEILING : l < -FSV_VOICE_CEILING ? -FSV_VOICE_CEILING : l;
    r = r > FSV_VOICE_CEILING ? FSV_VOICE_CEILING : r < -FSV_VOICE_CEILING ? -FSV_VOICE_CEILING : r;
    out[2 * k] = to_s16(l);
    out[2 * k + 1] = to_s16(r);
    float a = fmaxf(fabsf(l), fabsf(r));
    if (a > peak) peak = a;
  }
  if (clamped > 0) atomic_fetch_add_explicit(&clamp_hits, clamped, memory_order_relaxed);
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
  if (frame_index == cb_next_index) {
    int64_t gap = t0 - cb_last_ns;
    max_update(&cb_gap_max_us, gap / 1000);
    if (gap > OUTPUT_STALL_NS) {
      atomic_store_explicit(&last_stall_us, gap / 1000, memory_order_relaxed);
      atomic_fetch_add_explicit(&output_stalls, 1, memory_order_release);
    }
  }
  cb_last_ns = t0;
  cb_next_index = frame_index + frames;
  while (frames > 0) {
    int n = frames < RENDER_MAX ? frames : RENDER_MAX;
    render_piece(out, n, frame_index);
    out += 2 * n;
    frame_index += n;
    frames -= n;
  }
  int64_t busy = now_ns() - t0;
  hist_add(&h_callback, busy / 1000);
  atomic_fetch_add_explicit(&busy_ns, busy, memory_order_relaxed);
  if (busy > SLOW_CALLBACK_NS) atomic_fetch_add_explicit(&callbacks_over_2ms, 1, memory_order_relaxed);
  atomic_fetch_add_explicit(&callbacks, 1, memory_order_relaxed);
}

void fsv_clock_tick(void) {
  int64_t stalls = atomic_load_explicit(&output_stalls, memory_order_acquire);
  if (stalls == c_stalls_logged) return;
  int64_t now = now_ns();
  if (now - c_stall_logged_ns < LOG_EVERY_NS) return;
  int64_t gap_us = atomic_load_explicit(&last_stall_us, memory_order_relaxed);
  LOGW("fsv: output stall %d ms (%d in all)", (int)(gap_us / 1000), (int)stalls);
  c_stalls_logged = stalls;
  c_stall_logged_ns = now;
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
    while (count < max_blocks) {
      uint64_t zeros = atomic_load_explicit(&s->zeros, memory_order_acquire);
      /* Zero blocks go out once every block made before the detach has gone; reading the queue after
         the request sees all of those. */
      if ((uint32_t)zeros != 0) head = atomic_load_explicit(&s->tap_head, memory_order_acquire);
      const tap_block *b = tail != head ? &s->taps[tail % TAP_QUEUE] : NULL;
      int zero_next = (uint32_t)zeros != 0 && (b == NULL || (int32_t)(b->made - (uint32_t)(zeros >> 32)) > 0);
      if (zero_next) {
        if (!atomic_compare_exchange_weak_explicit(&s->zeros, &zeros, zeros - 1, memory_order_relaxed,
                                                   memory_order_relaxed)) {
          continue;
        }
        p = put_block(p, i + 1, 1, d->next_seq++, NULL);
        count++;
        continue;
      }
      if (b == NULL) break;
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
  }
  d_start = (d_start + 1) % FSV_SLOTS;
  if (count == 0) return 0;
  uint16_t count16 = (uint16_t)count;
  out[0] = 1;
  out[1] = 1;
  memcpy(out + 2, &count16, sizeof(count16));
  int64_t now = now_ns();
  if (d_last_ns != 0) {
    hist_add(&h_drain, (now - d_last_ns) / 1000);
    atomic_fetch_add_explicit(&drains, 1, memory_order_relaxed);
    if (now - d_last_ns > SLOW_DRAIN_NS) atomic_fetch_add_explicit(&drains_over_25ms, 1, memory_order_relaxed);
  }
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
    hist_window(&h_callback, snap_callback, NULL, NULL, &w_callback_p99, &w_callback_max);
    hist_window(&h_push, snap_push, &w_push_p50, NULL, &w_push_p99, &w_push_max);
    hist_window(&h_present, snap_present, &w_present_p50, &w_present_p95, NULL, NULL);
    hist_window(&h_drain, snap_drain, NULL, NULL, &w_drain_p99, &w_drain_max);
    int64_t lo = atomic_exchange_explicit(&ratio_lo_ppm, INT64_MAX, memory_order_relaxed);
    int64_t hi = atomic_exchange_explicit(&ratio_hi_ppm, INT64_MIN, memory_order_relaxed);
    w_ratio_min = hi == INT64_MIN ? 0 : lo;
    w_ratio_max = hi == INT64_MIN ? 0 : hi;
    w_longest_gap = atomic_exchange_explicit(&longest_gap_us, 0, memory_order_relaxed);
    int64_t busy = atomic_exchange_explicit(&busy_ns, 0, memory_order_relaxed);
    w_busy_permille = window_started_ns == 0 ? 0 : busy * 1000 / (now - window_started_ns);
    w_gap_max = atomic_exchange_explicit(&cb_gap_max_us, 0, memory_order_relaxed);
    window_started_ns = now;
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
  out[FSV_STATS_RATIO_MIN_PPM] = w_ratio_min;
  out[FSV_STATS_RATIO_MAX_PPM] = w_ratio_max;
  out[FSV_STATS_LONGEST_CONCEAL_US] = w_longest_gap;
  out[FSV_STATS_CALLBACK_BUSY_PERMILLE] = w_busy_permille;
  out[FSV_STATS_CALLBACK_GAP_MAX_US] = w_gap_max;
  pthread_mutex_unlock(&stats_lock);

  out[FSV_STATS_TAP_DROPPED] = atomic_load(&tap_dropped);
  out[FSV_STATS_PEAK_Q15] = atomic_exchange(&peak_q15, 0);
  out[FSV_STATS_CALLBACKS] = atomic_load(&callbacks);
  out[FSV_STATS_CONCEALS] = atomic_load(&conceals);
  out[FSV_STATS_RESYNCS] = atomic_load(&resyncs);
  out[FSV_STATS_CONCEALED_FRAMES] = atomic_load(&concealed_frames);
  out[FSV_STATS_SILENT_FRAMES] = atomic_load(&silent_frames);
  out[FSV_STATS_CLAMP_HITS] = atomic_load(&clamp_hits);
  for (int i = 0; i < FSV_SLOTS; i++) {
    int64_t *o = &out[FSV_STATS_SLOT_BASE + FSV_STATS_SLOT_STRIDE * i];
    o[FSV_SLOT_UNDERRUNS] = atomic_load(&slots[i].underruns);
    o[FSV_SLOT_DROPPED_FRAMES] = atomic_load(&slots[i].dropped);
    o[FSV_SLOT_LOW_WATER_FRAMES] = atomic_load(&slots[i].low_water);
    o[FSV_SLOT_PUSHED_FRAMES] = atomic_load(&slots[i].pushed);
  }
  out[FSV_STATS_OUTPUT_STALLS] = atomic_load(&output_stalls);
  out[FSV_STATS_PUSH_GAPS_20] = atomic_load(&push_gaps);
  out[FSV_STATS_PUSH_INTERVALS] = atomic_load(&push_intervals);
  out[FSV_STATS_CALLBACKS_OVER_2MS] = atomic_load(&callbacks_over_2ms);
  out[FSV_STATS_TAP_DRAINS_OVER_25MS] = atomic_load(&drains_over_25ms);
  out[FSV_STATS_TAP_DRAINS] = atomic_load(&drains);
}
