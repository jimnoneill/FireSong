/**
 * Timing for the noraebang two-line lyric bar.
 *
 * Two equal lines alternate within a verse: the verse's first line goes in
 * the top slot, its second in the bottom slot, and a slot moves on to the
 * line after next as soon as its line has been sung. A verse starts at the
 * first line and after every gap of `GAP_THRESHOLD_SEC` or more; the bar is
 * hidden in such gaps until `COUNTDOWN_SEC` before the next line, while four
 * dots count down.
 *
 * Each word wipes from left to right over its own start..end, using the
 * word timings from the transcript as they are.
 */

import { GAP_THRESHOLD_SEC } from '@/features/playback/utils/lyrics-gap';

/** The wipe starts this much before a word's start, s. */
export const WIPE_LEAD_SEC = 0.05;
/** A sung line stays this long before its slot moves on, s. */
export const LINE_LINGER_SEC = 0.25;
/** Lines appear this long before a verse starts, with the dot countdown, s. */
export const COUNTDOWN_SEC = 4;
/** Number of countdown dots. */
export const COUNTDOWN_DOTS = 4;
/** Words per line (upstream lyrics use 8). */
export const MAX_WORDS_PER_LINE = 6;

type Timed = { start: number; end: number };

export type LyricSlot = 'top' | 'bottom';

export type TwoLineState = {
  /** Segment index shown in the top slot, or `null`. */
  top: number | null;
  /** Segment index shown in the bottom slot, or `null`. */
  bottom: number | null;
  /** The line being sung or coming next, or `null` after the last line. */
  current: number | null;
  /** Lit countdown dots, 0..COUNTDOWN_DOTS. */
  countdownDots: number;
  /** Before the first line is shown: the title card is visible. */
  intro: boolean;
};

/** For each segment, the index of the first segment of its verse. */
export function verseStarts(segments: readonly Timed[]): number[] {
  const starts: number[] = [];
  segments.forEach((segment, index) => {
    const startsVerse = index === 0 || segment.start - segments[index - 1].end >= GAP_THRESHOLD_SEC;
    starts.push(startsVerse ? index : starts[index - 1]);
  });
  return starts;
}

/** The top/bottom slot of a segment inside its verse. */
export function slotOf(index: number, starts: readonly number[]): LyricSlot {
  return (index - starts[index]) % 2 === 0 ? 'top' : 'bottom';
}

function currentIndex(segments: readonly Timed[], time: number): number | null {
  const index = segments.findIndex((segment) => time < segment.end + LINE_LINGER_SEC);
  return index < 0 ? null : index;
}

function countdownDots(timeUntil: number): number {
  return timeUntil > 0 ? Math.min(COUNTDOWN_DOTS, Math.ceil(timeUntil)) : 0;
}

const HIDDEN: TwoLineState = {
  top: null,
  bottom: null,
  current: null,
  countdownDots: 0,
  intro: false,
};

export function twoLineState(
  segments: readonly Timed[],
  starts: readonly number[],
  time: number,
): TwoLineState {
  const current = currentIndex(segments, time);
  if (current === null) {
    return HIDDEN;
  }

  const timeUntil = segments[current].start - time;
  const verseStart = starts[current] === current;
  const intro = current === 0 && timeUntil > COUNTDOWN_SEC;
  if (verseStart && timeUntil > COUNTDOWN_SEC) {
    return { ...HIDDEN, current, intro };
  }

  const next = current + 1;
  const pair = next < segments.length && starts[next] === starts[current] ? next : null;
  const currentOnTop = slotOf(current, starts) === 'top';

  return {
    top: currentOnTop ? current : pair,
    bottom: currentOnTop ? pair : current,
    current,
    countdownDots: verseStart ? countdownDots(timeUntil) : 0,
    intro: false,
  };
}

/** Wipe progress of one word, 0..1, rising monotonically with `time`. */
export function wordWipeProgress(word: Timed, time: number): number {
  const start = word.start - WIPE_LEAD_SEC;
  const duration = word.end - word.start;
  if (!(duration > 0)) {
    return time >= start ? 1 : 0;
  }
  return Math.min(1, Math.max(0, (time - start) / duration));
}

/** CSS `clip-path` that reveals the left `progress` share of a word. */
export function wipeClipPath(progress: number): string {
  const hidden = Math.round((1 - Math.min(1, Math.max(0, progress))) * 10000) / 100;
  return `inset(0 ${hidden}% 0 0)`;
}
