import { describe, expect, it } from 'vitest';

import { PitchScoring } from '@/features/playback/lib/pitch/state';

const FRAME = 1 / 30;

/** Feeds `seconds` of frames at 30 fps; `voiced` decides whether the singer has a pitch. */
function sing(scoring: PitchScoring, from: number, seconds: number, voiced: boolean): number {
  let time = from;
  for (let frame = 0; frame < Math.round(seconds / FRAME); frame++) {
    time += FRAME;
    scoring.accumulate(time, 440, voiced ? 440 : null, voiced ? 1 : 0);
  }
  return time;
}

describe('PitchScoring voiced ratio', () => {
  it('counts the singable time in which the singer had a pitch', () => {
    const scoring = new PitchScoring(10);
    let time = sing(scoring, 0, 3, true);
    time = sing(scoring, time, 2, false);
    sing(scoring, time, 1, true);

    expect(scoring.voicedRatio()).toBeCloseTo(0.4, 2);
    expect(scoring.score()).toBe(400);
  });

  it('gives time back when playback seeks backwards', () => {
    const scoring = new PitchScoring(10);
    sing(scoring, 0, 4, true);
    expect(scoring.voicedRatio()).toBeCloseTo(0.4, 2);

    // Seek back to 1.5 s: only the first 1.5 s of singing still counts.
    scoring.accumulate(1.5, 440, 440, 1);
    expect(scoring.voicedRatio()).toBeCloseTo(0.15, 2);
    expect(scoring.score()).toBe(150);
  });

  it('never leaves 0-1 and ignores frames without a reference pitch', () => {
    const scoring = new PitchScoring(1);
    let time = 0;
    for (let frame = 0; frame < 120; frame++) {
      time += FRAME;
      scoring.accumulate(time, frame % 2 === 0 ? null : 440, 440, 1);
    }
    expect(scoring.voicedRatio()).toBe(1);
    expect(new PitchScoring(5).voicedRatio()).toBe(0);
  });
});
