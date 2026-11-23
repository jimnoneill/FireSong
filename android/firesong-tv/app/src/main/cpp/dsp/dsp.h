// The voice chain's building blocks, ported from the TV page's Web Audio
// graph (client/src/audio). All float32 at the engine rate.
#pragma once
#include <stdint.h>

/* biquad.c: Web Audio biquads (transposed direct form II) and the setTargetAtTime one-pole.
   The coefficient setters keep z1 and z2, so a filter can be retuned mid-stream; fsv_biquad_reset clears them. */
typedef struct { float b0, b1, b2, a1, a2, z1, z2; } fsv_biquad;
void  fsv_biquad_highpass(fsv_biquad *f, float fs, float hz, float q_db);
void  fsv_biquad_lowpass(fsv_biquad *f, float fs, float hz, float q_db);
void  fsv_biquad_peaking(fsv_biquad *f, float fs, float hz, float q, float gain_db);
float fsv_biquad_run(fsv_biquad *f, float x);
void  fsv_biquad_reset(fsv_biquad *f);

typedef struct { float coef, value, target; } fsv_ramp;
void  fsv_ramp_init(fsv_ramp *r, float fs, float tau_s, float value);
float fsv_ramp_next(fsv_ramp *r);

/* gate.c */
typedef struct { double env, gain; float threshold, env_att, env_rel, gain_att, gain_rel; int hold, hold_samples, meter_samples, meter_count; double meter_sum; } fsv_gate;
void  fsv_gate_init(fsv_gate *g, float fs, float threshold_rms);   /* linear RMS (FSV_GATE_THRESHOLD), not dB */
/* returns the gated sample; when *meter_ready is set, *meter_rms / *meter_open hold the last 50 ms block */
float fsv_gate_run(fsv_gate *g, float x, int *meter_ready, float *meter_rms, int *meter_open);

/* compressor.c */
typedef struct fsv_compressor fsv_compressor;   /* opaque, sized by fsv_compressor_size() */
int   fsv_compressor_size(void);
void  fsv_compressor_init(fsv_compressor *c, float fs, float threshold_db, float knee_db, float ratio, float attack_s, float release_s);
void  fsv_compressor_run_mono(fsv_compressor *c, float *io, int n);
void  fsv_compressor_run_stereo(fsv_compressor *c, float *l, float *r, int n);
void  fsv_compressor_reset(fsv_compressor *c);
float fsv_compressor_static_db(const fsv_compressor *c, float in_db);   /* acceptance check only */

/* echo.c */
typedef struct fsv_echo fsv_echo;               /* opaque; owns a 48000-float line */
int   fsv_echo_size(void);
void  fsv_echo_init(fsv_echo *e, float fs);
/* ramped tau 20 ms; feedback clamped to 0..0.6 (the loop's gain stays below 1) and lowpass_hz to 0..fs/2,
   NaN to 0; delay 120 ms and HP 300 Hz fixed */
void  fsv_echo_set(fsv_echo *e, float feedback, float lowpass_hz);
float fsv_echo_run(fsv_echo *e, float send);
void  fsv_echo_reset(fsv_echo *e);

/* reverb.c */
typedef struct fsv_reverb fsv_reverb;           /* opaque */
int   fsv_reverb_size(void);
/* energy_gain_db: the mean per-channel energy gain of the impulse response (FSV_REVERB_ENERGY_GAIN_DB).
   Returns 0, or -1 when fs or rt60_s is not positive. */
int   fsv_reverb_init(fsv_reverb *r, float fs, float rt60_s, float energy_gain_db);
void  fsv_reverb_run(fsv_reverb *r, const float *in, float *l, float *r_out, int n);   /* adds into l, r_out */

/* fft.c */
void  fsv_spectrum_db(const float *x2048, float *out_db1024, float *scratch4096);

/* guard.c */
typedef struct { float hz, level_db, prominence_db; } fsv_peak;
int   fsv_find_feedback_peak(const float *spectrum_db, int bins, float fs, fsv_peak *out);   /* 1 = found */
typedef struct { float candidate_hz; double since_ms; int reported, has; } fsv_tracker;
float fsv_tracker_update(fsv_tracker *t, const fsv_peak *peak_or_null, double now_ms);    /* hz or 0 */
void  fsv_tracker_reset(fsv_tracker *t);

/* level.c */
typedef struct { double singing; float boost_db, ceiling_db; } fsv_level;
void  fsv_level_init(fsv_level *l);                  /* boost 12, ceiling 24, singing = dbToGain(-36) */
int   fsv_level_step(fsv_level *l, float level_rms, int gate_open, float elapsed_s);  /* 1 when boost_db changed */
void  fsv_level_howl(fsv_level *l);                  /* ceiling -= 6 (>= 0), boost = min(boost, ceiling) */

/* goertzel.c */
float fsv_goertzel_amp(const float *x, int n, float fs, float hz);
