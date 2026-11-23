// The slot's echo loop (mic-rack.ts buildStrip): a fixed 120 ms delay, then
// lowpass, then highpass 300 Hz, whose output goes to the bus and, through the
// feedback gain, back into the delay.
#include <math.h>
#include <string.h>

#include "dsp.h"
#include "params.h"

#define LINE_FRAMES 48000
#define RETUNE_FRAMES 32
#define FILTER_Q_DB 1.0f

/* |HP 300 Hz x LP| peaks at 1.571 (lowpass near 500 Hz, both Q 1 dB), so a feedback above
   0.637 makes the loop grow. At 0.6 its gain stays at or under 0.943 for any lowpass. */
#define MAX_FEEDBACK 0.6f

struct fsv_echo {
  float line[LINE_FRAMES];
  int write;
  int delay;
  float fs;
  fsv_biquad lowpass;
  fsv_biquad highpass;
  fsv_ramp feedback;
  fsv_ramp lowpass_hz;
  float tuned_hz;
  int retune_in;
  float denormal;
};

int fsv_echo_size(void) { return (int)sizeof(struct fsv_echo); }

void fsv_echo_init(fsv_echo *e, float fs) {
  memset(e, 0, sizeof(*e));
  e->fs = fs;
  long delay = lround((double)fs * FSV_ECHO_DELAY_MS / 1000.0);
  if (delay < 1) delay = 1;
  if (delay > LINE_FRAMES - 1) delay = LINE_FRAMES - 1;
  e->delay = (int)delay;
  fsv_biquad_highpass(&e->highpass, fs, FSV_ECHO_HIGHPASS_HZ, FILTER_Q_DB);
  fsv_biquad_lowpass(&e->lowpass, fs, FSV_ECHO_LOWPASS_HZ, FILTER_Q_DB);
  e->tuned_hz = FSV_ECHO_LOWPASS_HZ;
  fsv_ramp_init(&e->feedback, fs, FSV_RAMP_SEC, FSV_ECHO_FEEDBACK);
  fsv_ramp_init(&e->lowpass_hz, fs, FSV_RAMP_SEC, FSV_ECHO_LOWPASS_HZ);
  fsv_echo_reset(e);
}

static float clamp(float x, float lo, float hi) {
  if (!(x >= lo)) return lo;
  return x > hi ? hi : x;
}

void fsv_echo_set(fsv_echo *e, float feedback, float lowpass_hz) {
  e->feedback.target = clamp(feedback, 0.0f, MAX_FEEDBACK);
  e->lowpass_hz.target = clamp(lowpass_hz, 0.0f, 0.5f * e->fs);
}

/* While the lowpass frequency glides, its coefficients follow every 32 frames;
   they stay put once the glide is within 1e-4 of them, and land on the target at the end. */
static void retune(fsv_echo *e, float hz) {
  e->retune_in = RETUNE_FRAMES;
  if (hz == e->tuned_hz) return;
  if (fabsf(hz - e->tuned_hz) <= 1e-4f * e->tuned_hz && hz != e->lowpass_hz.target) return;
  fsv_biquad_lowpass(&e->lowpass, e->fs, hz, FILTER_Q_DB);
  e->tuned_hz = hz;
}

float fsv_echo_run(fsv_echo *e, float send) {
  const float feedback = fsv_ramp_next(&e->feedback);
  const float hz = fsv_ramp_next(&e->lowpass_hz);
  if (--e->retune_in <= 0) retune(e, hz);

  int read = e->write - e->delay;
  if (read < 0) read += LINE_FRAMES;
  const float out = fsv_biquad_run(&e->highpass, fsv_biquad_run(&e->lowpass, e->line[read]));

  e->line[e->write] = send + feedback * out + e->denormal;
  e->denormal = -e->denormal;
  if (++e->write == LINE_FRAMES) e->write = 0;
  return out;
}

void fsv_echo_reset(fsv_echo *e) {
  memset(e->line, 0, sizeof(e->line));
  e->write = 0;
  e->retune_in = 0;
  e->denormal = 1e-20f;
  fsv_biquad_reset(&e->lowpass);
  fsv_biquad_reset(&e->highpass);
}
