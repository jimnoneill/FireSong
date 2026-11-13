import { describe, expect, it } from 'vitest';

import {
  COUNTDOWN_SEC,
  twoLineState,
  verseStarts,
  wipeClipPath,
  wordWipeProgress,
  WIPE_LEAD_SEC,
} from '@/features/noraebang/lyric-layout';

// Verse A: lines 0-3 back to back; a 10 s break; verse B: lines 4-6.
const LINES = [
  { start: 8, end: 11 },
  { start: 11.2, end: 14 },
  { start: 14.3, end: 17 },
  { start: 17.2, end: 20 },
  { start: 30, end: 33 },
  { start: 33.1, end: 36 },
  { start: 36.2, end: 39 },
];
const STARTS = verseStarts(LINES);
const at = (time: number) => twoLineState(LINES, STARTS, time);

describe('word wipe', () => {
  it('rises monotonically from 0 to 1 within each word', () => {
    const words = [
      { start: 1, end: 1.4 },
      { start: 1.4, end: 2.9 },
      { start: 3, end: 3.05 },
    ];
    for (const word of words) {
      let previous = -1;
      for (let time = word.start - 0.5; time <= word.end + 0.5; time += 0.01) {
        const progress = wordWipeProgress(word, time);
        expect(progress).toBeGreaterThanOrEqual(previous);
        expect(progress).toBeGreaterThanOrEqual(0);
        expect(progress).toBeLessThanOrEqual(1);
        previous = progress;
      }
      expect(wordWipeProgress(word, word.start - WIPE_LEAD_SEC - 0.01)).toBe(0);
      expect(wordWipeProgress(word, word.end)).toBe(1);
    }
  });

  it('jumps straight to full for a zero-length word', () => {
    const word = { start: 5, end: 5 };
    expect(wordWipeProgress(word, 4.9)).toBe(0);
    expect(wordWipeProgress(word, 5 - WIPE_LEAD_SEC)).toBe(1);
  });

  it('turns progress into a left-to-right clip-path', () => {
    expect(wipeClipPath(0)).toBe('inset(0 100% 0 0)');
    expect(wipeClipPath(0.25)).toBe('inset(0 75% 0 0)');
    expect(wipeClipPath(1)).toBe('inset(0 0% 0 0)');
    expect(wipeClipPath(7)).toBe('inset(0 0% 0 0)');
  });
});

describe('two-line bar', () => {
  it('finds verse starts at the first line and after long gaps', () => {
    expect(STARTS).toEqual([0, 0, 0, 0, 4, 4, 4]);
  });

  it('shows the title card during a long intro, then counts down with four dots', () => {
    expect(at(0)).toMatchObject({ top: null, bottom: null, intro: true, countdownDots: 0 });
    expect(at(8 - COUNTDOWN_SEC + 0.01)).toMatchObject({
      top: 0,
      bottom: 1,
      intro: false,
      countdownDots: 4,
    });
    expect(at(6.5).countdownDots).toBe(2);
    expect(at(7.5).countdownDots).toBe(1);
    expect(at(8).countdownDots).toBe(0);
  });

  it('alternates lines: a slot moves to the line after next once its line is sung', () => {
    expect(at(9)).toMatchObject({ top: 0, bottom: 1, current: 0 });
    expect(at(12)).toMatchObject({ top: 2, bottom: 1, current: 1 });
    expect(at(15)).toMatchObject({ top: 2, bottom: 3, current: 2 });
    // The last line of a verse has no partner.
    expect(at(18)).toMatchObject({ top: null, bottom: 3, current: 3 });
  });

  it('hides the bar in a long break and restarts the next verse on top', () => {
    expect(at(22)).toMatchObject({ top: null, bottom: null, current: 4, intro: false });
    expect(at(27)).toMatchObject({ top: 4, bottom: 5, countdownDots: 3 });
    expect(at(36.1)).toMatchObject({ top: 6, bottom: 5, current: 5 });
    expect(at(37)).toMatchObject({ top: 6, bottom: null, current: 6 });
  });

  it('is empty after the last line and for a song without lyrics', () => {
    expect(at(60)).toMatchObject({ top: null, bottom: null, current: null });
    expect(twoLineState([], [], 3)).toMatchObject({ top: null, bottom: null, current: null });
  });
});
