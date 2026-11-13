import { describe, expect, it } from 'vitest';

import { FeedbackTracker, findFeedbackPeak } from '@/audio/feedback-guard';

const SAMPLE_RATE = 48_000;
const FFT_SIZE = 2048;

const seeded = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32 - 0.5;
  };
};

/** What `AnalyserNode.getFloatFrequencyData` reports: Blackman window, |X|/N in dB. */
const analyserSpectrum = (signal: (n: number) => number): Float32Array => {
  const bins = FFT_SIZE / 2;
  const frame = new Float64Array(FFT_SIZE);
  for (let n = 0; n < FFT_SIZE; n += 1) {
    const x = n / FFT_SIZE;
    const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x);
    frame[n] = signal(n) * window;
  }
  const out = new Float32Array(bins);
  for (let k = 0; k < bins; k += 1) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < FFT_SIZE; n += 1) {
      const angle = (-2 * Math.PI * k * n) / FFT_SIZE;
      re += frame[n] * Math.cos(angle);
      im += frame[n] * Math.sin(angle);
    }
    out[k] = 20 * Math.log10(Math.max(1e-12, Math.hypot(re, im) / FFT_SIZE));
  }
  return out;
};

const tone =
  (partials: readonly [number, number][], noise = 1e-4, seed = 7) =>
  (n: number): number => {
    const random = seeded(seed + n);
    let sample = noise * random();
    for (const [hz, amplitude] of partials) {
      sample += amplitude * Math.sin((2 * Math.PI * hz * n) / SAMPLE_RATE);
    }
    return sample;
  };

describe('findFeedbackPeak', () => {
  it('flags a lone sinusoid (a howl)', () => {
    const peak = findFeedbackPeak(analyserSpectrum(tone([[1000, 0.3]])), SAMPLE_RATE);
    expect(peak).not.toBeNull();
    expect(peak?.frequencyHz ?? 0).toBeGreaterThan(1000 - 2 * (SAMPLE_RATE / FFT_SIZE));
    expect(peak?.frequencyHz ?? 0).toBeLessThan(1000 + 2 * (SAMPLE_RATE / FFT_SIZE));
    expect(peak?.prominenceDb ?? 0).toBeGreaterThanOrEqual(15);
  });

  it('ignores a sung note with harmonics', () => {
    const voice = tone([
      [220, 0.3],
      [440, 0.2],
      [660, 0.12],
      [880, 0.06],
    ]);
    expect(findFeedbackPeak(analyserSpectrum(voice), SAMPLE_RATE)).toBeNull();
  });

  it('ignores a voice whose second harmonic is the loudest partial', () => {
    const voice = tone([
      [180, 0.08],
      [360, 0.3],
      [540, 0.1],
    ]);
    expect(findFeedbackPeak(analyserSpectrum(voice), SAMPLE_RATE)).toBeNull();
  });

  it('ignores broadband noise and quiet signals', () => {
    expect(findFeedbackPeak(analyserSpectrum(tone([], 0.2)), SAMPLE_RATE)).toBeNull();
    expect(findFeedbackPeak(analyserSpectrum(tone([[1000, 1e-5]], 1e-7)), SAMPLE_RATE)).toBeNull();
  });

  it('ignores peaks outside the howl band', () => {
    expect(findFeedbackPeak(analyserSpectrum(tone([[60, 0.3]])), SAMPLE_RATE)).toBeNull();
  });
});

describe('FeedbackTracker', () => {
  const peak = (frequencyHz: number) => ({ frequencyHz, levelDb: -20, prominenceDb: 40 });

  it('confirms a howl after it persists for 300 ms, once per episode', () => {
    const tracker = new FeedbackTracker();
    expect(tracker.update(peak(1000), 0)).toBeNull();
    expect(tracker.update(peak(1005), 150)).toBeNull();
    expect(tracker.update(peak(998), 299)).toBeNull();
    expect(tracker.update(peak(1002), 300)).toBe(1000);
    expect(tracker.update(peak(1000), 400)).toBeNull();
  });

  it('starts over after a gap or a different frequency', () => {
    const tracker = new FeedbackTracker();
    tracker.update(peak(1000), 0);
    tracker.update(null, 200);
    expect(tracker.update(peak(1000), 250)).toBeNull();
    expect(tracker.update(peak(1000), 500)).toBeNull();
    expect(tracker.update(peak(2000), 600)).toBeNull();
    expect(tracker.update(peak(2000), 900)).toBe(2000);
  });
});
