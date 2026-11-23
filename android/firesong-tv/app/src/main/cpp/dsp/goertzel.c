// Single-frequency amplitude, as latency-test.ts toneAmplitude: 2 sqrt(power) / n.
#include <math.h>

#include "dsp.h"

static const double PI = 3.14159265358979323846;

float fsv_goertzel_amp(const float *x, int n, float fs, float hz) {
  if (n <= 0 || !(fs > 0.0f)) return 0.0f;
  const double coefficient = 2.0 * cos(2.0 * PI * (double)hz / (double)fs);
  double previous = 0.0;
  double before_previous = 0.0;
  for (int i = 0; i < n; i++) {
    const double current = x[i] + coefficient * previous - before_previous;
    before_previous = previous;
    previous = current;
  }
  const double power = previous * previous + before_previous * before_previous - coefficient * previous * before_previous;
  return (float)(2.0 * sqrt(fmax(0.0, power)) / n);
}
