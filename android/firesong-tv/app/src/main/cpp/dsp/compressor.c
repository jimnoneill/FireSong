// DynamicsCompressorNode equivalent.
#include <string.h>

#include "dsp.h"

struct fsv_compressor {
  float threshold_db;
};

int fsv_compressor_size(void) { return (int)sizeof(struct fsv_compressor); }

void fsv_compressor_init(fsv_compressor *c, float fs, float threshold_db, float knee_db, float ratio, float attack_s,
                         float release_s) {
  (void)fs;
  (void)knee_db;
  (void)ratio;
  (void)attack_s;
  (void)release_s;
  memset(c, 0, sizeof(*c));
  c->threshold_db = threshold_db;
}

void fsv_compressor_run_mono(fsv_compressor *c, float *io, int n) {
  (void)c;
  (void)io;
  (void)n;
}

void fsv_compressor_run_stereo(fsv_compressor *c, float *l, float *r, int n) {
  (void)c;
  (void)l;
  (void)r;
  (void)n;
}

void fsv_compressor_reset(fsv_compressor *c) { (void)c; }

float fsv_compressor_static_db(const fsv_compressor *c, float in_db) {
  (void)c;
  return in_db;
}
