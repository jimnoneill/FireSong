// The feedback guard of feedback-guard.ts: peak search and howl tracker.
#include <math.h>
#include <stddef.h>
#include <string.h>

#include "dsp.h"
#include "params.h"

#define MIN_HZ 150.0
#define MAX_HZ 8000.0
#define MIN_LEVEL_DB -70.0
/* A voice puts energy at simple ratios of its loudest partial; a howl is a lone sinusoid. */
#define HARMONIC_MARGIN_DB 25.0
#define HARMONIC_SEARCH_BINS 2
#define SAME_PEAK_RATIO 0.03
/* The band is copied to find its median; spectra of up to this many bins + 1. */
#define MAX_BAND (FSV_GUARD_FFT_SIZE / 2)

static const double HARMONIC_RATIOS[] = {1.0 / 3.0, 1.0 / 2.0, 2.0 / 3.0, 3.0 / 2.0, 2.0, 3.0};

static double max_around(const float *spectrum_db, int bins, int center) {
  double best = -INFINITY;
  const int from = center - HARMONIC_SEARCH_BINS > 0 ? center - HARMONIC_SEARCH_BINS : 0;
  const int to = center + HARMONIC_SEARCH_BINS < bins - 1 ? center + HARMONIC_SEARCH_BINS : bins - 1;
  for (int bin = from; bin <= to; bin++) {
    if (spectrum_db[bin] > best) best = spectrum_db[bin];
  }
  return best;
}

static double strongest_harmonic_db(const float *spectrum_db, int bins, int peak_bin) {
  double strongest = -INFINITY;
  for (size_t i = 0; i < sizeof(HARMONIC_RATIOS) / sizeof(HARMONIC_RATIOS[0]); i++) {
    const int bin = (int)floor(peak_bin * HARMONIC_RATIOS[i] + 0.5);
    if (bin > HARMONIC_SEARCH_BINS && bin < bins - HARMONIC_SEARCH_BINS) {
      const double around = max_around(spectrum_db, bins, bin);
      if (around > strongest) strongest = around;
    }
  }
  return strongest;
}

/* The k-th smallest of v[0..n-1] (quickselect); reorders v. */
static float select_kth(float *v, int n, int k) {
  int lo = 0;
  int hi = n - 1;
  while (lo < hi) {
    const float pivot = v[lo + (hi - lo) / 2];
    int i = lo;
    int j = hi;
    while (i <= j) {
      while (v[i] < pivot) i++;
      while (v[j] > pivot) j--;
      if (i <= j) {
        const float t = v[i];
        v[i] = v[j];
        v[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) {
      hi = j;
    } else if (k >= i) {
      lo = i;
    } else {
      return v[k];
    }
  }
  return v[k];
}

int fsv_find_feedback_peak(const float *spectrum_db, int bins, float fs, fsv_peak *out) {
  if (bins < 2 || !(fs > 0.0f)) return 0;
  const double hz_per_bin = (double)fs / (2.0 * bins);
  int from = (int)ceil(MIN_HZ / hz_per_bin);
  if (from < 1) from = 1;
  int to = (int)floor(MAX_HZ / hz_per_bin);
  if (to > bins - 1) to = bins - 1;
  if (to <= from) return 0;
  const int count = to - from + 1;
  if (count > MAX_BAND) return 0;

  int peak_bin = from;
  for (int bin = from + 1; bin <= to; bin++) {
    if (spectrum_db[bin] > spectrum_db[peak_bin]) peak_bin = bin;
  }
  const double level_db = spectrum_db[peak_bin];
  if (!isfinite(level_db) || level_db < MIN_LEVEL_DB) return 0;

  float band[MAX_BAND];
  memcpy(band, spectrum_db + from, (size_t)count * sizeof(float));
  const double prominence_db = level_db - select_kth(band, count, count / 2);
  if (prominence_db < FSV_FEEDBACK_PROMINENCE_DB ||
      level_db - strongest_harmonic_db(spectrum_db, bins, peak_bin) < HARMONIC_MARGIN_DB) {
    return 0;
  }
  out->hz = (float)(peak_bin * hz_per_bin);
  out->level_db = (float)level_db;
  out->prominence_db = (float)prominence_db;
  return 1;
}

/* Confirms a howl once the same peak (within 3 %) has lasted FSV_FEEDBACK_HOLD_MS; each episode is
   reported once, and a gap or a different frequency starts over. */
float fsv_tracker_update(fsv_tracker *t, const fsv_peak *peak_or_null, double now_ms) {
  if (peak_or_null == NULL) {
    fsv_tracker_reset(t);
    return 0.0f;
  }
  const double candidate = t->candidate_hz;
  const int same = t->has && fabs((double)peak_or_null->hz - candidate) <= candidate * SAME_PEAK_RATIO;
  if (!same) {
    t->candidate_hz = peak_or_null->hz;
    t->since_ms = now_ms;
    t->reported = 0;
    t->has = 1;
    return 0.0f;
  }
  if (t->reported || now_ms - t->since_ms < FSV_FEEDBACK_HOLD_MS) return 0.0f;
  t->reported = 1;
  return t->candidate_hz;
}

void fsv_tracker_reset(fsv_tracker *t) { memset(t, 0, sizeof(*t)); }
