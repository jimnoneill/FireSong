import { describe, expect, it } from 'vitest';

import {
  JITTER_MAX,
  noraebangDisplayScore,
  noraebangScore,
  rankScores,
  scoreJitter,
} from '@/features/noraebang/score';

const shown = (rawScore: number, voicedRatio: number, jitter = 0) =>
  noraebangDisplayScore({ rawScore, voicedRatio, jitter });

describe('noraebang display score', () => {
  it('orders the WP8 reference performances: stem > shifted > instrumental >= silence', () => {
    // Raw scores as Nightingale produces them: the vocal stem itself matches
    // almost every frame; +4 semitones earns 1 - 4/6 per voiced frame; the
    // instrumental makes the detector fire on accompaniment at random pitches.
    const stem = shown(860, 0.93);
    const shifted = shown(300, 0.9);
    const instrumental = shown(150, 0.5);
    const silence = shown(0, 0);

    expect(stem).toBeGreaterThanOrEqual(95);
    expect(stem).toBeGreaterThan(shifted);
    expect(shifted).toBeGreaterThan(instrumental);
    expect(instrumental).toBeGreaterThanOrEqual(silence);
    expect(silence).toBeLessThanOrEqual(10);
  });

  it('is lenient: decent attempts land between 80 and 96', () => {
    for (const [raw, voiced] of [
      [200, 0.6],
      [250, 0.7],
      [300, 0.75],
      [400, 0.85],
      [450, 0.9],
    ] as const) {
      const score = shown(raw, voiced);
      expect(score, `raw ${raw}, voiced ${voiced}`).toBeGreaterThanOrEqual(80);
      expect(score, `raw ${raw}, voiced ${voiced}`).toBeLessThanOrEqual(96);
    }
  });

  it('never decreases as the raw score rises', () => {
    for (const voiced of [0, 0.05, 0.1, 0.3, 0.6, 1]) {
      let previous = -1;
      for (let raw = 0; raw <= 1000; raw += 5) {
        const score = shown(raw, voiced);
        expect(score).toBeGreaterThanOrEqual(previous);
        previous = score;
      }
    }
  });

  it('never decreases as the voiced ratio rises from the participation floor', () => {
    for (const raw of [0, 50, 200, 400, 650]) {
      let previous = -1;
      for (let voiced = 0.1; voiced <= 1; voiced += 0.01) {
        const score = shown(raw, voiced);
        expect(score).toBeGreaterThanOrEqual(previous);
        previous = score;
      }
    }
  });

  it('shows an honest raw / 10 when almost nothing was sung, without jitter', () => {
    expect(shown(0, 0, 2)).toBe(0);
    expect(shown(40, 0.05, 2)).toBe(4);
    expect(shown(95, 0.099, -2)).toBe(10);
  });

  it('gives a participation floor of 40 + 20 * min(1, v / 0.6) once someone sang', () => {
    expect(shown(0, 0.1)).toBe(43);
    expect(shown(0, 0.3)).toBe(50);
    expect(shown(0, 0.6)).toBe(60);
    expect(shown(0, 1)).toBe(60);
  });

  it('snaps 98 and 99 to 100 but keeps 97', () => {
    expect(shown(650, 0.9)).toBe(100);
    expect(shown(560, 0.9)).toBe(100); // 98.9 before rounding
    expect(shown(480, 0.9)).toBe(97);
    expect(shown(480, 0.9, 1)).toBe(100);
  });

  it('stays within 0-100 for out-of-range and non-finite input', () => {
    for (const [raw, voiced, jitter] of [
      [-50, 0.5, 0],
      [5000, 2, 9],
      [Number.NaN, 0.5, 0],
      [500, Number.NaN, 0],
      [500, 0.5, Number.POSITIVE_INFINITY],
      [0, 0.2, -9],
    ]) {
      const score = shown(raw, voiced, jitter);
      expect(Number.isInteger(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it('clamps jitter to +-JITTER_MAX', () => {
    expect(shown(300, 0.9, 50) - shown(300, 0.9)).toBe(JITTER_MAX);
    expect(shown(300, 0.9, -50) - shown(300, 0.9)).toBe(-JITTER_MAX);
  });
});

describe('score jitter', () => {
  it('is deterministic per performance and covers -2..2', () => {
    expect(scoreJitter('song:p1')).toBe(scoreJitter('song:p1'));
    const seen = new Set<number>();
    for (let index = 0; index < 200; index++) {
      const jitter = scoreJitter(`hash-${index}:player-${index % 4}`);
      expect(Number.isInteger(jitter)).toBe(true);
      expect(Math.abs(jitter)).toBeLessThanOrEqual(JITTER_MAX);
      seen.add(jitter);
    }
    expect([...seen].toSorted((a, b) => a - b)).toEqual([-2, -1, 0, 1, 2]);
  });
});

describe('noraebang score', () => {
  it('keeps the raw score and derives the tier from the shown score', () => {
    expect(noraebangScore({ rawScore: 650, voicedRatio: 0.9 })).toEqual({
      displayScore: 100,
      rawScore: 650,
      tier: 'perfect',
    });
    expect(noraebangScore({ rawScore: 1234.4, voicedRatio: 0.9 }).rawScore).toBe(1000);

    const tiers = [100, 99, 90, 89, 80, 79, 70, 69, 0].map((target) => {
      const raw = findRaw(target);
      return noraebangScore({ rawScore: raw, voicedRatio: 1 }).tier;
    });
    expect(tiers).toEqual([
      'perfect',
      'perfect', // 99 snaps to 100
      'excellent',
      'great',
      'great',
      'good',
      'good',
      'retry',
      'retry',
    ]);
  });

  it('ranks by shown score, raw score breaking ties, sharing equal ranks', () => {
    const score = (displayScore: number, rawScore: number) => ({
      displayScore,
      rawScore,
      tier: 'great' as const,
    });
    expect(rankScores([score(88, 300), score(95, 400), score(88, 320), score(88, 300)])).toEqual([
      3, 1, 2, 3,
    ]);
    expect(rankScores([])).toEqual([]);
  });
});

/** Smallest raw score that shows `target` at full participation (0 for anything below the floor). */
function findRaw(target: number): number {
  for (let raw = 0; raw <= 1000; raw++) {
    if (shown(raw, 1) >= target) {
      return raw;
    }
  }
  return 1000;
}
