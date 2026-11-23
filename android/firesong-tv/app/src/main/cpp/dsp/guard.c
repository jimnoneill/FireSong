// The feedback guard of feedback-guard.ts: peak search and howl tracker.
#include <string.h>

#include "dsp.h"

int fsv_find_feedback_peak(const float *spectrum_db, int bins, float fs, fsv_peak *out) {
  (void)spectrum_db;
  (void)bins;
  (void)fs;
  (void)out;
  return 0;
}

float fsv_tracker_update(fsv_tracker *t, const fsv_peak *peak_or_null, double now_ms) {
  (void)t;
  (void)peak_or_null;
  (void)now_ms;
  return 0.0f;
}

void fsv_tracker_reset(fsv_tracker *t) { memset(t, 0, sizeof(*t)); }
