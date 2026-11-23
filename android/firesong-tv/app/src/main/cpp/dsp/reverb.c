// ConvolverNode equivalent: an 8-line feedback delay network.
#include <string.h>

#include "dsp.h"

struct fsv_reverb {
  float gain;
};

int fsv_reverb_size(void) { return (int)sizeof(struct fsv_reverb); }

int fsv_reverb_init(fsv_reverb *r, float fs, float rt60_s, float energy_gain_db) {
  (void)fs;
  (void)rt60_s;
  (void)energy_gain_db;
  memset(r, 0, sizeof(*r));
  return 0;
}

void fsv_reverb_run(fsv_reverb *r, const float *in, float *l, float *r_out, int n) {
  (void)r;
  (void)in;
  (void)l;
  (void)r_out;
  (void)n;
}
