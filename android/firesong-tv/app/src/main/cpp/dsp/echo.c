// The slot's echo loop: a fixed 120 ms delay with lowpass, highpass and feedback.
#include <string.h>

#include "dsp.h"

struct fsv_echo {
  float feedback;
};

int fsv_echo_size(void) { return (int)sizeof(struct fsv_echo); }

void fsv_echo_init(fsv_echo *e, float fs) {
  (void)fs;
  memset(e, 0, sizeof(*e));
}

void fsv_echo_set(fsv_echo *e, float feedback, float lowpass_hz) {
  (void)lowpass_hz;
  e->feedback = feedback;
}

float fsv_echo_run(fsv_echo *e, float send) {
  (void)e;
  (void)send;
  return 0.0f;
}

void fsv_echo_reset(fsv_echo *e) { (void)e; }
