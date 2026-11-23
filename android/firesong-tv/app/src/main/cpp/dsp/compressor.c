/*
 * DynamicsCompressorNode equivalent: a port of Chromium's DynamicsCompressor
 * kernel (third_party/blink/renderer/platform/audio/dynamics_compressor.cc,
 * branch 7204 / Chrome 138).
 *
 * Copyright (C) 2011 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * 1.  Redistributions of source code must retain the above copyright
 *     notice, this list of conditions and the following disclaimer.
 * 2.  Redistributions in binary form must reproduce the above copyright
 *     notice, this list of conditions and the following disclaimer in the
 *     documentation and/or other materials provided with the distribution.
 * 3.  Neither the name of Apple Computer, Inc. ("Apple") nor the names of
 *     its contributors may be used to endorse or promote products derived
 *     from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY APPLE AND ITS CONTRIBUTORS "AS IS" AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL APPLE OR ITS CONTRIBUTORS BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// Changes from Chromium: no pre-delay (the gain is applied to the input it was
// computed from), any frame count (the 32-frame division carries across
// calls), a stereo link that detects on max(|l|, |r|), and no metering. The
// parameters are clamped to the DynamicsCompressorNode AudioParam ranges.
#include <float.h>
#include <math.h>
#include <string.h>

#include "dsp.h"

#define DIVISION_FRAMES 32

static const float PI_OVER_TWO = 1.57079632679489661923f;

/* Release zone values 0 -> 1. */
static const float RELEASE_ZONE1 = 0.09f;
static const float RELEASE_ZONE2 = 0.16f;
static const float RELEASE_ZONE3 = 0.42f;
static const float RELEASE_ZONE4 = 0.98f;

/* Detector release time. */
static const float SAT_RELEASE_TIME = 0.0025f;

struct fsv_compressor {
  /* Static curve. */
  float linear_threshold, slope, k, knee_threshold, db_knee_threshold, db_yknee_threshold;
  float linear_post_gain;
  /* Envelope rates. */
  float attack_frames, sat_release_frames, sat_release_rate_min;
  float release_a, release_b, release_c, release_d, release_e;
  /* State. */
  float detector_average, compressor_gain, db_max_attack_compression_diff;
  float scaled_desired_gain, envelope_rate;
  float warp_from, warp_value;
  int division_left;
};

static float lin_to_db(float linear) { return 20.0f * log10f(linear); }

static float db_to_lin(float db) { return powf(10.0f, 0.05f * db); }

static float ensure_finite(float x, float fallback) { return isfinite(x) ? x : fallback; }

static float flush_denormal(float x) { return fabsf(x) < FLT_MIN ? 0.0f : x; }

static float clamp(float x, float lo, float hi) {
  if (!(x >= lo)) return lo;
  return x > hi ? hi : x;
}

/* Exponential knee, 1st derivative matched at linear_threshold, approaching linear_threshold + 1/k. */
static float knee_curve(const struct fsv_compressor *c, float x, float k) {
  if (x < c->linear_threshold) return x;
  return c->linear_threshold + (1.0f - (float)exp((double)(-k * (x - c->linear_threshold)))) / k;
}

/* Full compression curve with constant ratio after the knee. */
static float saturate(const struct fsv_compressor *c, float x, float k) {
  if (x < c->knee_threshold) return knee_curve(c, x, k);
  const float db_x = lin_to_db(x);
  const float db_y = c->db_yknee_threshold + c->slope * (db_x - c->db_knee_threshold);
  return db_to_lin(db_y);
}

static float k_at_slope(const struct fsv_compressor *c, float db_threshold, float db_knee, float desired_slope) {
  const float db_x = db_threshold + db_knee;
  const float x = db_to_lin(db_x);
  float x2 = 1.0f;
  float db_x2 = 0.0f;
  if (!(x < c->linear_threshold)) {
    x2 = (float)((double)x * 1.001);
    db_x2 = lin_to_db(x2);
  }

  float min_k = 0.1f;
  float max_k = 10000.0f;
  float k = 5.0f;
  float slope = 1.0f;
  for (int i = 0; i < 15; i++) {
    if (!(x < c->linear_threshold)) {
      const float db_y = lin_to_db(knee_curve(c, x, k));
      const float db_y2 = lin_to_db(knee_curve(c, x2, k));
      slope = (db_y2 - db_y) / (db_x2 - db_x);
    }
    if (slope < desired_slope) {
      max_k = k;
    } else {
      min_k = k;
    }
    k = sqrtf(min_k * max_k);
  }
  return k;
}

int fsv_compressor_size(void) { return (int)sizeof(struct fsv_compressor); }

void fsv_compressor_init(fsv_compressor *c, float fs, float threshold_db, float knee_db, float ratio, float attack_s,
                         float release_s) {
  memset(c, 0, sizeof(*c));
  threshold_db = clamp(threshold_db, -100.0f, 0.0f);
  knee_db = clamp(knee_db, 0.0f, 40.0f);
  ratio = clamp(ratio, 1.0f, 20.0f);
  attack_s = clamp(attack_s, 0.0f, 1.0f);
  release_s = clamp(release_s, 0.0f, 1.0f);

  c->linear_threshold = db_to_lin(threshold_db);
  c->slope = 1.0f / ratio;
  const float k = k_at_slope(c, threshold_db, knee_db, 1.0f / ratio);
  c->db_knee_threshold = threshold_db + knee_db;
  c->knee_threshold = db_to_lin(c->db_knee_threshold);
  c->db_yknee_threshold = lin_to_db(knee_curve(c, c->knee_threshold, k));
  c->k = k;

  /* Makeup gain with empirical/perceptual tuning. */
  c->linear_post_gain = powf(1.0f / saturate(c, 1.0f, k), 0.6f);

  c->attack_frames = fmaxf(0.001f, attack_s) * fs;
  c->sat_release_frames = SAT_RELEASE_TIME * fs;
  c->sat_release_rate_min = db_to_lin(2.0f / c->sat_release_frames) - 1.0f;

  /* Adaptive release: a 4th order polynomial through four points of release frames,
     x = 0..3 for -15, -10, -5 and 0 dB of compression. */
  const float a_base = 0.9999999999999998f * RELEASE_ZONE1 + 1.8432219684323923e-16f * RELEASE_ZONE2 -
                       1.9373394351676423e-16f * RELEASE_ZONE3 + 8.824516011816245e-18f * RELEASE_ZONE4;
  const float b_base = -1.5788320352845888f * RELEASE_ZONE1 + 2.3305837032074286f * RELEASE_ZONE2 -
                       0.9141194204840429f * RELEASE_ZONE3 + 0.1623677525612032f * RELEASE_ZONE4;
  const float c_base = 0.5334142869106424f * RELEASE_ZONE1 - 1.272736789213631f * RELEASE_ZONE2 +
                       0.9258856042207512f * RELEASE_ZONE3 - 0.18656310191776226f * RELEASE_ZONE4;
  const float d_base = 0.08783463138207234f * RELEASE_ZONE1 - 0.1694162967925622f * RELEASE_ZONE2 +
                       0.08588057951595272f * RELEASE_ZONE3 - 0.00429891410546283f * RELEASE_ZONE4;
  const float e_base = -0.042416883008123074f * RELEASE_ZONE1 + 0.1115693827987602f * RELEASE_ZONE2 -
                       0.09764676325265872f * RELEASE_ZONE3 + 0.028494263462021576f * RELEASE_ZONE4;
  const float release_frames = fs * release_s;
  c->release_a = release_frames * a_base;
  c->release_b = release_frames * b_base;
  c->release_c = release_frames * c_base;
  c->release_d = release_frames * d_base;
  c->release_e = release_frames * e_base;

  fsv_compressor_reset(c);
}

void fsv_compressor_reset(fsv_compressor *c) {
  c->detector_average = 0.0f;
  c->compressor_gain = 1.0f;
  c->db_max_attack_compression_diff = -1.0f;
  c->scaled_desired_gain = 0.0f;
  c->envelope_rate = 1.0f;
  c->warp_from = NAN;
  c->warp_value = 0.0f;
  c->division_left = 0;
}

/* The desired gain and the envelope rate, once per 32-frame division. */
static void begin_division(struct fsv_compressor *c) {
  c->detector_average = ensure_finite(c->detector_average, 1.0f);
  const float desired_gain = c->detector_average;

  /* Pre-warp so we get desired_gain after the sin() warp. */
  const float scaled_desired_gain = asinf(desired_gain) / PI_OVER_TWO;

  const int is_releasing = scaled_desired_gain > c->compressor_gain;
  float db_compression_diff;
  if (scaled_desired_gain == 0.0f) {
    db_compression_diff = is_releasing ? -1.0f : 1.0f;
  } else {
    db_compression_diff = lin_to_db(c->compressor_gain / scaled_desired_gain);
  }

  float envelope_rate;
  if (is_releasing) {
    c->db_max_attack_compression_diff = -1.0f;
    db_compression_diff = ensure_finite(db_compression_diff, -1.0f);

    /* Adaptive release: higher compression releases faster. -12..0 dB maps to 0..3. */
    float x = clamp(db_compression_diff, -12.0f, 0.0f);
    x = 0.25f * (x + 12.0f);
    const float x2 = x * x;
    const float x3 = x2 * x;
    const float x4 = x2 * x2;
    const float calc_release_frames =
        c->release_a + c->release_b * x + c->release_c * x2 + c->release_d * x3 + c->release_e * x4;
    const float db_per_frame = 5.0f / calc_release_frames;
    envelope_rate = db_to_lin(db_per_frame);
  } else {
    db_compression_diff = ensure_finite(db_compression_diff, 1.0f);
    if (c->db_max_attack_compression_diff == -1.0f || c->db_max_attack_compression_diff < db_compression_diff) {
      c->db_max_attack_compression_diff = db_compression_diff;
    }
    const float db_eff_atten_diff = fmaxf(0.5f, c->db_max_attack_compression_diff);
    const float x = 0.25f / db_eff_atten_diff;
    envelope_rate = 1.0f - powf(x, 1.0f / c->attack_frames);
  }

  c->scaled_desired_gain = scaled_desired_gain;
  c->envelope_rate = envelope_rate;
  c->division_left = DIVISION_FRAMES;
}

/* One frame: feeds the detector with the frame's peak and returns the gain to apply. */
static float next_gain(struct fsv_compressor *c, float abs_input) {
  if (c->division_left == 0) begin_division(c);

  const float shaped_input = saturate(c, abs_input, c->k);
  const float attenuation = abs_input <= 0.0001f ? 1.0f : shaped_input / abs_input;

  /* The detector attacks at once and releases at a rate that grows with the attenuation. */
  float detector_average = c->detector_average;
  float rate = 1.0f;
  if (attenuation > detector_average) {
    rate = c->sat_release_rate_min;
    if (attenuation != 1.0f) {
      const float db_attenuation = fmaxf(2.0f, -lin_to_db(attenuation));
      rate = db_to_lin(db_attenuation / c->sat_release_frames) - 1.0f;
    }
  }
  detector_average += (attenuation - detector_average) * rate;
  detector_average = fminf(1.0f, detector_average);
  detector_average = ensure_finite(detector_average, 1.0f);

  float compressor_gain = c->compressor_gain;
  if (c->envelope_rate < 1.0f) {
    compressor_gain += (c->scaled_desired_gain - compressor_gain) * c->envelope_rate;
  } else {
    compressor_gain *= c->envelope_rate;
    compressor_gain = fminf(1.0f, compressor_gain);
  }

  /* Warp the gain to smooth out sharp exponential transition points. */
  if (compressor_gain != c->warp_from) {
    c->warp_from = compressor_gain;
    c->warp_value = (float)sin((double)(PI_OVER_TWO * compressor_gain));
  }

  if (--c->division_left == 0) {
    detector_average = flush_denormal(detector_average);
    compressor_gain = flush_denormal(compressor_gain);
  }
  c->detector_average = detector_average;
  c->compressor_gain = compressor_gain;
  return c->linear_post_gain * c->warp_value;
}

/* |x| the way the kernel takes it: a NaN sample leaves the detector input at 0. */
static float louder(float peak, float x) {
  const float a = x > 0.0f ? x : -x;
  return peak < a ? a : peak;
}

void fsv_compressor_run_mono(fsv_compressor *c, float *io, int n) {
  for (int i = 0; i < n; i++) {
    const float gain = next_gain(c, louder(0.0f, io[i]));
    io[i] *= gain;
  }
}

void fsv_compressor_run_stereo(fsv_compressor *c, float *l, float *r, int n) {
  for (int i = 0; i < n; i++) {
    const float gain = next_gain(c, louder(louder(0.0f, l[i]), r[i]));
    l[i] *= gain;
    r[i] *= gain;
  }
}

float fsv_compressor_static_db(const fsv_compressor *c, float in_db) {
  return lin_to_db(saturate(c, db_to_lin(in_db), c->k) * c->linear_post_gain);
}
