// FireSong TV native voice engine (libfiresongvoice.so): the phones' voices,
// received by libwebrtc in the app, run through the voice chain and played
// through AAudio's low-latency output. Slots are 1..4 in this API.
#pragma once
#include <stdint.h>

#define FSV_ABI 1
#define FSV_RATE 48000
#define FSV_SLOTS 4               /* API slots 1..4, arrays 0..3 */
#define FSV_TAP_FRAMES 512
#define FSV_TAP_BLOCK_BYTES 2056  /* 8 + 512*4 */
#define FSV_TAP_MAX_BLOCKS 31
#define FSV_STATUS_LEN 8
#define FSV_STATS_LEN 40

enum fsv_result { FSV_OK = 0, FSV_ERR_STATE = -1, FSV_ERR_ARG = -2, FSV_ERR_FORMAT = -3, FSV_ERR_AUDIO = -4, FSV_ERR_STALE = -5 };
enum fsv_control { FSV_MONITOR = 1, FSV_MUTED = 2, FSV_VOLUME = 3, FSV_ECHO_AMOUNT = 4, FSV_TAP = 5 };

/* fsv_slot_status() layout. */
enum fsv_status_index {
  FSV_STATUS_LEVEL_RMS = 0,
  FSV_STATUS_GATE_OPEN = 1,
  FSV_STATUS_FEEDBACK_HZ = 2, /* 0 = none */
  FSV_STATUS_BOOST_DB = 3,
  FSV_STATUS_FILL_MS = 4,
  FSV_STATUS_OUT_RMS = 5,     /* post-monitor, last 50 ms */
  FSV_STATUS_ATTACHED = 6,
  FSV_STATUS_DUCKED_MS = 7    /* remaining */
};

/* fsv_engine_stats() layout: engine-wide values, then FSV_STATS_SLOT_STRIDE per slot. */
enum fsv_stats_index {
  FSV_STATS_OPEN = 0,
  FSV_STATS_OUTPUT_LATENCY_US = 1, /* -1 = unknown */
  FSV_STATS_BURST_FRAMES = 2,
  FSV_STATS_BUFFER_FRAMES = 3,
  FSV_STATS_XRUNS = 4,
  FSV_STATS_RESTARTS = 5,
  FSV_STATS_CALLBACK_P99_US = 6,
  FSV_STATS_CALLBACK_MAX_US = 7,
  FSV_STATS_PUSH_INTERVAL_P50_US = 8,
  FSV_STATS_PUSH_INTERVAL_P99_US = 9,
  FSV_STATS_PUSH_INTERVAL_MAX_US = 10,
  FSV_STATS_PUSH_TO_PRESENT_P50_US = 11,
  FSV_STATS_PUSH_TO_PRESENT_P95_US = 12,
  FSV_STATS_TAP_DROPPED = 13,
  FSV_STATS_PEAK_Q15 = 14,         /* reset on read */
  FSV_STATS_CALLBACKS = 15,
  FSV_STATS_TAP_DRAIN_P99_US = 16, /* interval between fsv_drain_tap calls that returned blocks */
  FSV_STATS_TAP_DRAIN_MAX_US = 17,
  FSV_STATS_OPEN_ATTEMPTS = 18
  /* 19-23 reserved (0) */
};

/* Slot s (1..4) starts at FSV_STATS_SLOT_BASE + FSV_STATS_SLOT_STRIDE * (s - 1). */
#define FSV_STATS_SLOT_BASE 24
#define FSV_STATS_SLOT_STRIDE 4
enum fsv_stats_slot_index { FSV_SLOT_UNDERRUNS = 0, FSV_SLOT_TRIMMED_FRAMES = 1, FSV_SLOT_MARGIN_FRAMES = 2, FSV_SLOT_PUSHED_FRAMES = 3 };

/* fsv_monitor_result() layout. */
enum fsv_monitor_state { FSV_MONITOR_PENDING = 0, FSV_MONITOR_DONE = 1, FSV_MONITOR_FAILED = 2 };
enum fsv_monitor_reason { FSV_MONITOR_BUSY = 1, FSV_MONITOR_NO_AUDIO = 2, FSV_MONITOR_NO_TONE = 3, FSV_MONITOR_STOPPED = 4 };

/* C = control thread (fs-mics via JNI), P = push thread (WebRTC worker), R = AAudio callback,
   G = guard thread, D = door writer (fs-voice-out). */
int  fsv_start(void);                                      /* C: new session token > 0; start G and the clock thread; try AAudio, else retry from the restart thread (2 s, backing off to 10 s) */
void fsv_stop(int token);                                  /* C: no-op unless token is current; stop G, close AAudio, join clock and restart threads, reset all slots */
void fsv_attach(int slot, int gen);                        /* C */
void fsv_detach(int slot, int gen);                        /* C: no-op if gen is not current */
void fsv_release(int slot);                                /* C */
int  fsv_push(int slot, int gen, const int16_t *pcm, int frames, int rate, int channels); /* P: tap blocks ready (>= 0) or a negative fsv_result */
int  fsv_set(int slot, int control, float value);          /* C */
int  fsv_set_echo_mix(float wet, float feedback, float lowpass_hz, float reverb_send); /* C */
int  fsv_drain_tap(uint8_t *out, int capacity);            /* D: one complete tap message, its length; 0 when none */
void fsv_slot_status(int slot, float out[FSV_STATUS_LEN]); /* any */
void fsv_engine_stats(int64_t out[FSV_STATS_LEN]);         /* any */
int  fsv_measure_monitor(int slot);                        /* C: token > 0, or <= 0 (busy / not running / no audio) */
void fsv_monitor_result(int token, float out[3]);          /* C: state, ms, reason */

/* Engine-internal seam (engine.c <-> aaudio_out.c). frame_index = frames written to the stream before this call. */
void fsv_render(int16_t *out, int frames, int64_t frame_index); /* R */

/* aaudio_out.c */
typedef void (*fsv_render_fn)(int16_t *out, int frames, int64_t frame_index);
int  ao_open(fsv_render_fn render);   /* LOW_LATENCY, SHARED, 48 kHz, 2 ch, I16, usage MEDIA, content MUSIC, buffer = 2 bursts; starts fsv-clock; on failure the restart thread keeps trying */
void ao_close(void);                  /* stops and closes; joins fsv-clock and a pending restart; no restart after this returns */
int  ao_presentation_ns(int64_t frame_index, int64_t *t_ns); /* from the timestamp fsv-clock publishes (seqlock); FSV_ERR_STATE if none yet */
void ao_stats(int64_t *burst, int64_t *buffer, int64_t *xruns, int64_t *latency_us, int64_t *restarts, int64_t *open);
