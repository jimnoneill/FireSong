// Web Audio biquads and the setTargetAtTime one-pole.
#include <string.h>

#include "dsp.h"

static void passthrough(fsv_biquad *f) {
  memset(f, 0, sizeof(*f));
  f->b0 = 1.0f;
}

void fsv_biquad_highpass(fsv_biquad *f, float fs, float hz, float q_db) {
  (void)fs;
  (void)hz;
  (void)q_db;
  passthrough(f);
}

void fsv_biquad_lowpass(fsv_biquad *f, float fs, float hz, float q_db) {
  (void)fs;
  (void)hz;
  (void)q_db;
  passthrough(f);
}

void fsv_biquad_peaking(fsv_biquad *f, float fs, float hz, float q, float gain_db) {
  (void)fs;
  (void)hz;
  (void)q;
  (void)gain_db;
  passthrough(f);
}

float fsv_biquad_run(fsv_biquad *f, float x) { return f->b0 * x; }

void fsv_biquad_reset(fsv_biquad *f) {
  f->z1 = 0.0f;
  f->z2 = 0.0f;
}

void fsv_ramp_init(fsv_ramp *r, float fs, float tau_s, float value) {
  (void)fs;
  (void)tau_s;
  r->coef = 1.0f;
  r->value = value;
  r->target = value;
}

float fsv_ramp_next(fsv_ramp *r) {
  r->value = r->target;
  return r->value;
}
