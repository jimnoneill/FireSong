// The voice output: one AAudio low-latency stream, its clock thread and its
// restart path.
#include "fsv_api.h"

int ao_open(fsv_render_fn render) {
  (void)render;
  return FSV_ERR_AUDIO;
}

void ao_close(void) {}

int ao_presentation_ns(int64_t frame_index, int64_t *t_ns) {
  (void)frame_index;
  (void)t_ns;
  return FSV_ERR_STATE;
}

void ao_stats(int64_t *burst, int64_t *buffer, int64_t *xruns, int64_t *latency_us, int64_t *restarts, int64_t *open) {
  *burst = 0;
  *buffer = 0;
  *xruns = 0;
  *latency_us = -1;
  *restarts = 0;
  *open = 0;
}
