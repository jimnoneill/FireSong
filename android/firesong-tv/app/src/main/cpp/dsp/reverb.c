// ConvolverNode equivalent: an 8-line feedback delay network with a
// Householder feedback matrix, flat decay to -60 dB at rt60_s, a mono input
// and decorrelated left and right outputs. fsv_reverb_init renders the
// impulse response once and scales the output so that its mean per-channel
// energy equals energy_gain_db, the convolver's.
#include <math.h>
#include <string.h>

#include "dsp.h"
#include "params.h"

#define LINES FSV_FDN_LINES
#define CAPACITY 15792 /* the sum of FSV_FDN_LENGTHS */

static const int LENGTHS[LINES] = FSV_FDN_LENGTHS;

/* Input and output signs; the 1/sqrt(8) of both is folded into in_gain and out_gain. The three
   vectors are orthogonal to each other and to (1, ..., 1), the Householder matrix's -1 eigenvector,
   so left and right carry equal energy from the first reflections on. */
static const float IN_SIGN[LINES] = {1, -1, 1, -1, 1, -1, 1, -1};
static const float LEFT_SIGN[LINES] = {1, 1, 1, 1, -1, -1, -1, -1};
static const float RIGHT_SIGN[LINES] = {1, 1, -1, -1, 1, 1, -1, -1};

struct fsv_reverb {
  float buffer[CAPACITY];
  int offset[LINES];
  int position[LINES];
  float decay[LINES];
  float in_gain;
  float out_gain;
  float denormal;
};

int fsv_reverb_size(void) { return (int)sizeof(struct fsv_reverb); }

static void clear(fsv_reverb *r) {
  memset(r->buffer, 0, sizeof(r->buffer));
  memset(r->position, 0, sizeof(r->position));
  r->denormal = 1e-20f;
}

static void step(fsv_reverb *r, float x, float *left, float *right) {
  float out[LINES];
  float sum = 0.0f;
  float l = 0.0f;
  float rr = 0.0f;
  for (int i = 0; i < LINES; i++) {
    const float o = r->buffer[r->offset[i] + r->position[i]];
    l += LEFT_SIGN[i] * o;
    rr += RIGHT_SIGN[i] * o;
    out[i] = r->decay[i] * o;
    sum += out[i];
  }
  *left = l * r->out_gain;
  *right = rr * r->out_gain;

  /* Householder feedback, H = I - (2/8) 1 1^T. */
  const float householder = 0.25f * sum;
  const float input = x * r->in_gain;
  for (int i = 0; i < LINES; i++) {
    r->buffer[r->offset[i] + r->position[i]] = IN_SIGN[i] * input + out[i] - householder + r->denormal;
    if (++r->position[i] == LENGTHS[i]) r->position[i] = 0;
  }
  r->denormal = -r->denormal;
}

int fsv_reverb_init(fsv_reverb *r, float fs, float rt60_s, float energy_gain_db) {
  memset(r, 0, sizeof(*r));
  if (!(fs > 0.0f) || !(rt60_s > 0.0f)) return -1;

  int offset = 0;
  for (int i = 0; i < LINES; i++) {
    r->offset[i] = offset;
    offset += LENGTHS[i];
    r->decay[i] = (float)pow(10.0, -3.0 * LENGTHS[i] / ((double)fs * rt60_s));
  }
  if (offset > CAPACITY) return -1;

  const float norm = (float)(1.0 / sqrt((double)LINES));
  r->in_gain = norm;
  r->out_gain = norm;
  clear(r);

  /* The impulse response over 3 x RT60 (-180 dB), unscaled. */
  const long frames = lround(3.0 * rt60_s * (double)fs);
  double energy_l = 0.0;
  double energy_r = 0.0;
  for (long n = 0; n < frames; n++) {
    float l;
    float rr;
    step(r, n == 0 ? 1.0f : 0.0f, &l, &rr);
    energy_l += (double)l * l;
    energy_r += (double)rr * rr;
  }
  const double energy = 0.5 * (energy_l + energy_r);
  if (!(energy > 0.0)) return -1;

  r->out_gain = (float)(norm * sqrt(pow(10.0, energy_gain_db / 10.0) / energy));
  clear(r);
  return 0;
}

void fsv_reverb_run(fsv_reverb *r, const float *in, float *l, float *r_out, int n) {
  for (int i = 0; i < n; i++) {
    float left;
    float right;
    step(r, in[i], &left, &right);
    l[i] += left;
    r_out[i] += right;
  }
}
