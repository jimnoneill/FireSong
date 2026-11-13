import { FEEDBACK_HOLD_MS, FEEDBACK_PROMINENCE_DB } from './voice-params';

/** A spectral peak that looks like acoustic feedback (a howl). */
export type FeedbackPeak = { frequencyHz: number; levelDb: number; prominenceDb: number };

const MIN_HZ = 150;
const MAX_HZ = 8000;
const MIN_LEVEL_DB = -70;
/**
 * A voice puts energy at simple ratios of its loudest partial; a howl is a
 * lone sinusoid. A partial this close to the peak means "voice".
 */
const HARMONIC_MARGIN_DB = 25;
const HARMONIC_RATIOS = [1 / 3, 1 / 2, 2 / 3, 3 / 2, 2, 3];
const HARMONIC_SEARCH_BINS = 2;
const SAME_PEAK_RATIO = 0.03;

const binHz = (bins: number, sampleRate: number): number => sampleRate / (2 * bins);

const maxAround = (spectrumDb: Float32Array, center: number): number => {
  let best = Number.NEGATIVE_INFINITY;
  const from = Math.max(0, center - HARMONIC_SEARCH_BINS);
  const to = Math.min(spectrumDb.length - 1, center + HARMONIC_SEARCH_BINS);
  for (let bin = from; bin <= to; bin += 1) {
    best = Math.max(best, spectrumDb[bin]);
  }
  return best;
};

const median = (values: Float32Array): number => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const strongestHarmonicDb = (spectrumDb: Float32Array, peakBin: number): number => {
  let strongest = Number.NEGATIVE_INFINITY;
  for (const ratio of HARMONIC_RATIOS) {
    const bin = Math.round(peakBin * ratio);
    if (bin > HARMONIC_SEARCH_BINS && bin < spectrumDb.length - HARMONIC_SEARCH_BINS) {
      strongest = Math.max(strongest, maxAround(spectrumDb, bin));
    }
  }
  return strongest;
};

/**
 * Looks for a narrowband peak more than 15 dB above the spectrum's median,
 * without the harmonic partials a voice would have. `spectrumDb` is an
 * `AnalyserNode.getFloatFrequencyData` frame.
 */
export const findFeedbackPeak = (
  spectrumDb: Float32Array,
  sampleRate: number,
): FeedbackPeak | null => {
  const hzPerBin = binHz(spectrumDb.length, sampleRate);
  const from = Math.max(1, Math.ceil(MIN_HZ / hzPerBin));
  const to = Math.min(spectrumDb.length - 1, Math.floor(MAX_HZ / hzPerBin));
  if (to <= from) {
    return null;
  }
  const band = spectrumDb.subarray(from, to + 1);
  let peakOffset = 0;
  for (let offset = 1; offset < band.length; offset += 1) {
    if (band[offset] > band[peakOffset]) {
      peakOffset = offset;
    }
  }
  const levelDb = band[peakOffset];
  if (!Number.isFinite(levelDb) || levelDb < MIN_LEVEL_DB) {
    return null;
  }
  const prominenceDb = levelDb - median(band);
  const peakBin = from + peakOffset;
  if (
    prominenceDb < FEEDBACK_PROMINENCE_DB ||
    levelDb - strongestHarmonicDb(spectrumDb, peakBin) < HARMONIC_MARGIN_DB
  ) {
    return null;
  }
  return { frequencyHz: peakBin * hzPerBin, levelDb, prominenceDb };
};

/**
 * Confirms a howl once the same peak has persisted for 300 ms. Reports each
 * episode once; a gap or a different frequency starts over.
 */
export class FeedbackTracker {
  private candidateHz: number | null = null;
  private since = 0;
  private reported = false;

  constructor(private readonly holdMs = FEEDBACK_HOLD_MS) {}

  update(peak: FeedbackPeak | null, nowMs: number): number | null {
    if (peak === null) {
      this.reset();
      return null;
    }
    const candidate = this.candidateHz;
    const same =
      candidate !== null && Math.abs(peak.frequencyHz - candidate) <= candidate * SAME_PEAK_RATIO;
    if (!same) {
      this.candidateHz = peak.frequencyHz;
      this.since = nowMs;
      this.reported = false;
      return null;
    }
    if (this.reported || nowMs - this.since < this.holdMs) {
      return null;
    }
    this.reported = true;
    return candidate;
  }

  reset(): void {
    this.candidateHz = null;
    this.reported = false;
  }
}
