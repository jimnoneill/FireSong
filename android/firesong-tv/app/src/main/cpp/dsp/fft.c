// The AnalyserNode spectrum (Web Audio "FFT windowing and smoothing over
// time", smoothing 0): Blackman window (alpha 0.16), 2048-point real FFT,
// |X[k]| / N in dB for bins 0..1023.
//
// The real FFT is a 1024-point complex FFT of the windowed samples taken in
// pairs, then split into the even and odd halves. Twiddles and the window come
// from double-precision rotations, so there is no table and no shared state.
#include <math.h>

#include "dsp.h"

#define N 2048
#define M (N / 2)

static const double PI = 3.14159265358979323846;

/* In place, M complex values (re, im interleaved), forward. */
static void fft(float *z) {
  for (int i = 1, j = 0; i < M; i++) {
    int bit = M >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const float re = z[2 * i];
      const float im = z[2 * i + 1];
      z[2 * i] = z[2 * j];
      z[2 * i + 1] = z[2 * j + 1];
      z[2 * j] = re;
      z[2 * j + 1] = im;
    }
  }

  for (int half = 1; half < M; half <<= 1) {
    const double rotate_re = cos(PI / half);
    const double rotate_im = -sin(PI / half);
    double w_re = 1.0;
    double w_im = 0.0;
    for (int j = 0; j < half; j++) {
      const float wr = (float)w_re;
      const float wi = (float)w_im;
      for (int k = j; k < M; k += 2 * half) {
        float *a = z + 2 * k;
        float *b = z + 2 * (k + half);
        const float tr = b[0] * wr - b[1] * wi;
        const float ti = b[0] * wi + b[1] * wr;
        b[0] = a[0] - tr;
        b[1] = a[1] - ti;
        a[0] += tr;
        a[1] += ti;
      }
      const double next = w_re * rotate_re - w_im * rotate_im;
      w_im = w_re * rotate_im + w_im * rotate_re;
      w_re = next;
    }
  }
}

void fsv_spectrum_db(const float *x2048, float *out_db1024, float *scratch4096) {
  float *z = scratch4096;

  /* Blackman: 0.42 - 0.5 cos(2 pi n / N) + 0.08 cos(4 pi n / N), with cos(2a) = 2 cos^2(a) - 1. */
  const double step_re = cos(2.0 * PI / N);
  const double step_im = sin(2.0 * PI / N);
  double c = 1.0;
  double s = 0.0;
  for (int n = 0; n < N; n++) {
    const double window = 0.42 - 0.5 * c + 0.08 * (2.0 * c * c - 1.0);
    z[n] = x2048[n] * (float)window;
    const double next = c * step_re - s * step_im;
    s = c * step_im + s * step_re;
    c = next;
  }

  fft(z);

  /* X[k] = E[k] + W^k O[k], with E = (Z[k] + conj Z[M-k]) / 2 and O = (Z[k] - conj Z[M-k]) / 2i. */
  const double twiddle_re = cos(2.0 * PI / N);
  const double twiddle_im = -sin(2.0 * PI / N);
  double w_re = 1.0;
  double w_im = 0.0;
  for (int k = 0; k < M; k++) {
    const int kc = (M - k) & (M - 1);
    const double zr = z[2 * k];
    const double zi = z[2 * k + 1];
    const double cr = z[2 * kc];
    const double ci = -(double)z[2 * kc + 1];
    const double even_re = 0.5 * (zr + cr);
    const double even_im = 0.5 * (zi + ci);
    const double odd_re = 0.5 * (zi - ci);
    const double odd_im = -0.5 * (zr - cr);
    const double re = even_re + w_re * odd_re - w_im * odd_im;
    const double im = even_im + w_re * odd_im + w_im * odd_re;
    const float magnitude = (float)(sqrt(re * re + im * im) / N);
    out_db1024[k] = 20.0f * log10f(magnitude);

    const double next = w_re * twiddle_re - w_im * twiddle_im;
    w_im = w_re * twiddle_im + w_im * twiddle_re;
    w_re = next;
  }
}
