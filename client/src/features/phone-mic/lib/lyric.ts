import type { LyricView } from './party-state';

/**
 * How much of the current line has been sung at `now` (wall clock, ms), from
 * 0 to 1, or `null` when the TV sent no line length. Frozen while paused. The
 * TV stays the reference: the wipe is only cosmetic.
 */
export const lyricProgress = (lyric: LyricView, now: number): number | null => {
  if (lyric.lineMs === undefined || lyric.lineMs <= 0) {
    return null;
  }
  const running = lyric.paused ? 0 : Math.max(0, now - lyric.receivedAt);
  const elapsed = (lyric.elapsedMs ?? 0) + running;
  return Math.min(1, Math.max(0, elapsed / lyric.lineMs));
};

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** User-perceived characters, so the wipe never splits an emoji or a Hangul syllable. */
export const graphemes = (text: string): string[] =>
  Array.from(segmenter.segment(text), (part) => part.segment);

/** Characters of `count` lit at `progress`. */
export const litCount = (count: number, progress: number): number =>
  Math.min(count, Math.max(0, Math.round(count * progress)));
