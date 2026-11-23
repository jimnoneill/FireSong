// Web Audio biquads and the setTargetAtTime one-pole.
//
// The coefficients follow the Web Audio formulas
// (https://webaudio.github.io/web-audio-api/#filters-characteristics) with
// Chromium's edge cases at 0 Hz and Nyquist, are computed in double, and are
// stored normalised by a0. The filter runs as transposed direct form II. The
// setters keep z1 and z2, so a gliding filter can be retuned mid-stream;
// fsv_biquad_reset clears them.
#include <float.h>
#include <math.h>

#include "dsp.h"

static const double PI = 3.14159265358979323846;

/* AudioParamTimeline: a setTarget glide ends on its target once it is this close (e^-10). */
static const float SETTLED = 4.539992976248485e-05f;
static const float SETTLED_ZERO = 1e-20f;

static void set_coefficients(fsv_biquad *f, double b0, double b1, double b2, double a0, double a1, double a2) {
  f->b0 = (float)(b0 / a0);
  f->b1 = (float)(b1 / a0);
  f->b2 = (float)(b2 / a0);
  f->a1 = (float)(a1 / a0);
  f->a2 = (float)(a2 / a0);
}

/* The frequency as a fraction of Nyquist, clamped to [0, 1]. */
static double normalized(float fs, float hz) {
  const double nyquist = 0.5 * (double)fs;
  if (!(nyquist > 0.0) || !(hz > 0.0f)) return 0.0;
  const double f = (double)hz / nyquist;
  return f < 1.0 ? f : 1.0;
}

void fsv_biquad_highpass(fsv_biquad *f, float fs, float hz, float q_db) {
  const double cutoff = normalized(fs, hz);
  if (cutoff >= 1.0) {
    set_coefficients(f, 0, 0, 0, 1, 0, 0);
  } else if (cutoff > 0.0) {
    const double theta = PI * cutoff;
    const double alpha = sin(theta) / (2.0 * pow(10.0, (double)q_db / 20.0));
    const double cosw = cos(theta);
    const double beta = (1.0 + cosw) / 2.0;
    set_coefficients(f, beta, -2.0 * beta, beta, 1.0 + alpha, -2.0 * cosw, 1.0 - alpha);
  } else {
    set_coefficients(f, 1, 0, 0, 1, 0, 0);
  }
}

void fsv_biquad_lowpass(fsv_biquad *f, float fs, float hz, float q_db) {
  const double cutoff = normalized(fs, hz);
  if (cutoff >= 1.0) {
    set_coefficients(f, 1, 0, 0, 1, 0, 0);
  } else if (cutoff > 0.0) {
    const double theta = PI * cutoff;
    const double alpha = sin(theta) / (2.0 * pow(10.0, (double)q_db / 20.0));
    const double cosw = cos(theta);
    const double beta = (1.0 - cosw) / 2.0;
    set_coefficients(f, beta, 2.0 * beta, beta, 1.0 + alpha, -2.0 * cosw, 1.0 - alpha);
  } else {
    set_coefficients(f, 0, 0, 0, 1, 0, 0);
  }
}

void fsv_biquad_peaking(fsv_biquad *f, float fs, float hz, float q, float gain_db) {
  const double frequency = normalized(fs, hz);
  const double a = pow(10.0, (double)gain_db / 40.0);
  if (frequency > 0.0 && frequency < 1.0) {
    if (q > 0.0f) {
      const double w0 = PI * frequency;
      const double alpha = sin(w0) / (2.0 * (double)q);
      const double k = cos(w0);
      set_coefficients(f, 1.0 + alpha * a, -2.0 * k, 1.0 - alpha * a, 1.0 + alpha / a, -2.0 * k, 1.0 - alpha / a);
    } else {
      set_coefficients(f, a * a, 0, 0, 1, 0, 0);
    }
  } else {
    set_coefficients(f, 1, 0, 0, 1, 0, 0);
  }
}

/* The state decays toward zero in silence; it is flushed before it turns subnormal. */
static float flush_denormal(float x) { return fabsf(x) < FLT_MIN ? 0.0f : x; }

float fsv_biquad_run(fsv_biquad *f, float x) {
  const float y = f->b0 * x + f->z1;
  f->z1 = flush_denormal(f->b1 * x - f->a1 * y + f->z2);
  f->z2 = flush_denormal(f->b2 * x - f->a2 * y);
  return y;
}

void fsv_biquad_reset(fsv_biquad *f) {
  f->z1 = 0.0f;
  f->z2 = 0.0f;
}

void fsv_ramp_init(fsv_ramp *r, float fs, float tau_s, float value) {
  const double samples = (double)fs * (double)tau_s;
  r->coef = samples > 0.0 ? (float)-expm1(-1.0 / samples) : 1.0f;
  r->value = value;
  r->target = value;
}

/* Like AudioParamTimeline's setTarget: this sample gets the current value, then it moves on. It
   lands on the target once close enough, or once a step is too small to change a float. */
float fsv_ramp_next(fsv_ramp *r) {
  const float value = r->value;
  const float target = r->target;
  if (value != target) {
    float next = value + (target - value) * r->coef;
    const float left = fabsf(target - next);
    if (next == value || (target == 0.0f ? left < SETTLED_ZERO : left < SETTLED * fabsf(target))) next = target;
    r->value = next;
  }
  return value;
}
