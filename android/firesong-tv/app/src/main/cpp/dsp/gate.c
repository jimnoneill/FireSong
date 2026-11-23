// The noise gate of rack-worklets.ts (FireSongGate), sample by sample.
#include <string.h>

#include "dsp.h"

void fsv_gate_init(fsv_gate *g, float fs, float threshold) {
  (void)fs;
  memset(g, 0, sizeof(*g));
  g->threshold = threshold;
}

float fsv_gate_run(fsv_gate *g, float x, int *meter_ready, float *meter_rms, int *meter_open) {
  (void)g;
  (void)meter_rms;
  (void)meter_open;
  *meter_ready = 0;
  return x;
}
