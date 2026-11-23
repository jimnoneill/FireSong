// The noise gate of rack-worklets.ts (FireSongGate), sample by sample.
//
// The worklet keeps its state in doubles; here the update runs in double and
// is stored in the struct's fields. The coefficients hold 1 - e^(-1/(fs*t)),
// the step toward the target, which keeps full precision in a float. The
// envelope and gain decay toward zero in silence and are flushed before they
// turn subnormal.
#include <float.h>
#include <math.h>

#include "dsp.h"

static float step_toward(float fs, double seconds) { return (float)-expm1(-1.0 / ((double)fs * seconds)); }

static double flush_denormal(double x) { return x < FLT_MIN ? 0.0 : x; }

void fsv_gate_init(fsv_gate *g, float fs, float threshold_rms) {
  g->env = 0.0f;
  g->gain = 0.0f;
  g->threshold = threshold_rms;
  g->env_att = step_toward(fs, 0.002);
  g->env_rel = step_toward(fs, 0.05);
  g->gain_att = step_toward(fs, 0.002);
  g->gain_rel = step_toward(fs, 0.12);
  g->hold = 0;
  g->hold_samples = (int)lround((double)fs * 0.08);
  g->meter_samples = (int)lround((double)fs * 0.05);
  g->meter_count = 0;
  g->meter_sum = 0.0;
}

float fsv_gate_run(fsv_gate *g, float x, int *meter_ready, float *meter_rms, int *meter_open) {
  const double sample = x;
  const double square = sample * sample;
  const double env = g->env;
  const double k = square > env ? g->env_att : g->env_rel;
  g->env = flush_denormal(env + (square - env) * k);

  const double open = g->threshold;
  const double rms = sqrt(g->env);
  if (rms >= open || (g->hold > 0 && rms >= open * 0.5)) {
    g->hold = g->hold_samples;
  } else if (g->hold > 0) {
    g->hold--;
  }

  const double target = g->hold > 0 ? 1.0 : 0.0;
  const double gain = g->gain;
  const double s = target > gain ? g->gain_att : g->gain_rel;
  g->gain = flush_denormal(gain + (target - gain) * s);

  g->meter_sum += square;
  g->meter_count++;
  if (g->meter_count >= g->meter_samples) {
    *meter_ready = 1;
    *meter_rms = (float)sqrt(g->meter_sum / g->meter_count);
    *meter_open = g->hold > 0;
    g->meter_sum = 0.0;
    g->meter_count = 0;
  } else {
    *meter_ready = 0;
  }
  return (float)(sample * g->gain);
}
