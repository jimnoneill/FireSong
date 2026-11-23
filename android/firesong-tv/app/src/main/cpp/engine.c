// The native voice engine: sessions, slots, the input stage at push, the
// output stage and mix in the AAudio callback, the tap queue and statistics.
#include <string.h>

#include "fsv_api.h"

int fsv_start(void) { return FSV_ERR_STATE; }

void fsv_stop(int token) { (void)token; }

void fsv_attach(int slot, int gen) {
  (void)slot;
  (void)gen;
}

void fsv_detach(int slot, int gen) {
  (void)slot;
  (void)gen;
}

void fsv_release(int slot) { (void)slot; }

int fsv_push(int slot, int gen, const int16_t *pcm, int frames, int rate, int channels) {
  (void)slot;
  (void)gen;
  (void)pcm;
  (void)frames;
  (void)rate;
  (void)channels;
  return FSV_ERR_STATE;
}

int fsv_set(int slot, int control, float value) {
  (void)slot;
  (void)control;
  (void)value;
  return FSV_ERR_STATE;
}

int fsv_set_echo_mix(float wet, float feedback, float lowpass_hz, float reverb_send) {
  (void)wet;
  (void)feedback;
  (void)lowpass_hz;
  (void)reverb_send;
  return FSV_ERR_STATE;
}

int fsv_drain_tap(uint8_t *out, int capacity) {
  (void)out;
  (void)capacity;
  return 0;
}

void fsv_slot_status(int slot, float out[FSV_STATUS_LEN]) {
  (void)slot;
  memset(out, 0, FSV_STATUS_LEN * sizeof(float));
}

void fsv_engine_stats(int64_t out[FSV_STATS_LEN]) {
  memset(out, 0, FSV_STATS_LEN * sizeof(int64_t));
  out[FSV_STATS_OUTPUT_LATENCY_US] = -1;
}

int fsv_measure_monitor(int slot) {
  (void)slot;
  return -FSV_MONITOR_STOPPED;
}

void fsv_monitor_result(int token, float out[3]) {
  (void)token;
  out[0] = FSV_MONITOR_FAILED;
  out[1] = 0;
  out[2] = FSV_MONITOR_STOPPED;
}

void fsv_render(int16_t *out, int frames, int64_t frame_index) {
  (void)frame_index;
  memset(out, 0, (size_t)frames * 2 * sizeof(int16_t));
}
