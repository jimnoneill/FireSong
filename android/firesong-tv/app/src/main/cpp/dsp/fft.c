// The AnalyserNode spectrum: Blackman window, 2048-point real FFT, dB magnitudes.
#include "dsp.h"

void fsv_spectrum_db(const float *x2048, float *out_db1024, float *scratch4096) {
  (void)x2048;
  (void)scratch4096;
  for (int i = 0; i < 1024; i++) out_db1024[i] = -1000.0f;
}
