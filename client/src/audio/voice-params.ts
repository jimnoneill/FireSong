/**
 * Tuning values and pure helpers of the FireSong voice engine (design §3 and
 * §6e). Gains are linear, levels in dBFS, times in milliseconds unless the
 * name says otherwise.
 */

export const HPF_HZ = 100;

export const COMPRESSOR_THRESHOLD_DB = -24;
export const COMPRESSOR_RATIO = 4;
export const BUS_COMPRESSOR_THRESHOLD_DB = -18;
export const BUS_COMPRESSOR_RATIO = 3;
export const LIMITER_THRESHOLD_DB = -6;
export const LIMITER_RATIO = 20;

export const ECHO_MIN_DELAY_MS = 90;
export const ECHO_MAX_DELAY_MS = 220;
export const ECHO_LOW_LATENCY_MS = 60;
export const ECHO_FIXED_DELAY_MS = 160;
export const ECHO_FEEDBACK = 0.38;
export const ECHO_LOWPASS_HZ = 3500;
export const ECHO_WET_GAIN = 0.35;
export const ECHO_LATE_WET_GAIN = 0.5;
export const ECHO_LATE_DRY_GAIN = 0.75;

export const REVERB_SEND = 0.2;
export const REVERB_SECONDS = 1.4;

export const GATE_FLOOR_MARGIN_DB = 12;
export const GATE_MIN_THRESHOLD_DB = -60;
export const GATE_MAX_THRESHOLD_DB = -30;
export const GATE_LEARN_MS = 3000;
const GATE_BLEED_PERCENTILE = 0.2;

export const FEEDBACK_PROMINENCE_DB = 15;
export const FEEDBACK_HOLD_MS = 300;
export const FEEDBACK_NOTCH_DB = -12;
export const FEEDBACK_NOTCH_Q = 30;
export const FEEDBACK_DUCK_DB = -6;
export const FEEDBACK_RELEASE_MS = 4000;

export const MAX_LATENCY_MS = 1000;

export const dbToGain = (db: number): number => 10 ** (db / 20);

export const gainToDb = (gain: number): number =>
  gain > 0 ? 20 * Math.log10(gain) : Number.NEGATIVE_INFINITY;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Echo and reverb levels chosen by the echo preset (noraebang settings,
 * `features/noraebang/echo.ts`). The delay never comes from the preset: it
 * stays locked to the slot's latency.
 */
export type EchoMix = {
  /** Echo send level for a slot within the latency budget. */
  wet: number;
  feedback: number;
  lowpassHz: number;
  reverbSend: number;
};

export const DEFAULT_ECHO_MIX: EchoMix = {
  wet: ECHO_WET_GAIN,
  feedback: ECHO_FEEDBACK,
  lowpassHz: ECHO_LOWPASS_HZ,
  reverbSend: REVERB_SEND,
};

/** A late slot's wet level is raised by the same ratio as the default mix. */
const LATE_WET_RATIO = ECHO_LATE_WET_GAIN / ECHO_WET_GAIN;
const MAX_WET_GAIN = 0.6;

export type EchoSettings = {
  /** `d_i`, the slot's echo delay. */
  delayMs: number;
  dryGain: number;
  wetGain: number;
  /** The measured latency is above the echo range; the TV should warn. */
  late: boolean;
};

/**
 * The latency-locked echo: `d_i = clamp(L_i, 90, 220)` ms, so the singer hears
 * an even echo train at 0, L, 2L. An unknown or very low latency gets a fixed
 * 160 ms echo; a latency above the range raises the wet/dry ratio.
 */
export const echoSettingsFor = (
  latencyMs: number | null,
  mix: EchoMix = DEFAULT_ECHO_MIX,
): EchoSettings => {
  if (latencyMs === null || !Number.isFinite(latencyMs) || latencyMs < ECHO_LOW_LATENCY_MS) {
    return { delayMs: ECHO_FIXED_DELAY_MS, dryGain: 1, wetGain: mix.wet, late: false };
  }
  if (latencyMs > ECHO_MAX_DELAY_MS) {
    return {
      delayMs: ECHO_MAX_DELAY_MS,
      dryGain: ECHO_LATE_DRY_GAIN,
      wetGain: Math.min(MAX_WET_GAIN, mix.wet * LATE_WET_RATIO),
      late: true,
    };
  }
  return {
    delayMs: clamp(latencyMs, ECHO_MIN_DELAY_MS, ECHO_MAX_DELAY_MS),
    dryGain: 1,
    wetGain: mix.wet,
    late: false,
  };
};

const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
};

/**
 * Gate threshold (linear RMS) learned from level readings taken while the
 * singer is quiet: the low percentile of the bleed plus 12 dB, kept inside a
 * range that never gates normal singing. `null` keeps the current threshold.
 */
export const gateThresholdFromBleed = (rmsReadings: readonly number[]): number | null => {
  const usable = rmsReadings.filter((rms) => Number.isFinite(rms) && rms >= 0);
  if (usable.length === 0) {
    return null;
  }
  const bleedDb = gainToDb(percentile(usable, GATE_BLEED_PERCENTILE));
  return dbToGain(
    clamp(bleedDb + GATE_FLOOR_MARGIN_DB, GATE_MIN_THRESHOLD_DB, GATE_MAX_THRESHOLD_DB),
  );
};

export const clampLatencyMs = (latencyMs: number): number => clamp(latencyMs, 0, MAX_LATENCY_MS);
