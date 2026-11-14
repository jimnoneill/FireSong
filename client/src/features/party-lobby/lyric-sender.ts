import { LINE_LINGER_SEC } from '@/features/noraebang/lyric-layout';
import { GAP_THRESHOLD_SEC } from '@/features/playback/utils/lyrics-gap';
import { MAX_LINE_MS } from '@/features/remote-mic/protocol';

import type { LyricFrame } from './party-store';

/**
 * The lyric line for the singers' phones (PROTOCOL.md §13.5 `lyric`). The TV
 * owns the one playback clock, so it sends the current and next line on each
 * line change, pause, resume and seek, never per animation frame, and at most
 * two frames a second; the phone wipes the line on its own from `elapsedMs`.
 */

/** A lyric line on the playback clock (seconds; tempo variants are already stretched). */
export type LyricLine = { text: string; start: number; end: number };

export type LyricPayload = Omit<LyricFrame, 'type'>;

export type LyricSenderPorts = {
  send(frame: LyricPayload): void;
  /** Wall clock, ms. */
  now(): number;
  /** Runs `fn` after `ms`; returns the cancel function. */
  later(fn: () => void, ms: number): () => void;
};

export const LYRIC_MIN_INTERVAL_MS = 500;
/** A clock jump larger than this between updates is a seek, s. */
const SEEK_TOLERANCE_SEC = 0.5;

/**
 * The line a singer sees at `time`: the last line that has started, while it
 * is sung and until the next line of its verse starts. Nothing in the gaps
 * between verses.
 */
export const phoneLineAt = (lines: readonly LyricLine[], time: number): number | null => {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].start <= time) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (found < 0) {
    return null;
  }
  const line = lines[found];
  const next = lines.at(found + 1);
  const inVerse = next !== undefined && next.start - line.end < GAP_THRESHOLD_SEC;
  return time < line.end + LINE_LINGER_SEC || inVerse ? found : null;
};

const clampMs = (ms: number): number => Math.min(MAX_LINE_MS, Math.max(0, Math.round(ms)));

/** The frame for line `index` at `time`. */
export const lyricPayload = (
  lines: readonly LyricLine[],
  index: number | null,
  time: number,
  paused: boolean,
): LyricPayload => {
  const line = index === null ? undefined : lines.at(index);
  if (index === null || line === undefined) {
    return { paused };
  }
  const lineMs = clampMs((line.end - line.start) * 1000);
  const next = lines.at(index + 1);
  return {
    line: line.text,
    ...(next === undefined ? {} : { next: next.text }),
    lineMs,
    elapsedMs: Math.min(lineMs, clampMs((time - line.start) * 1000)),
    paused,
  };
};

export class LyricLineSender {
  private index: number | null | undefined = undefined;
  private paused = false;
  private time = 0;
  private timeAt = 0;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private cancelPending: (() => void) | null = null;

  constructor(
    private readonly ports: LyricSenderPorts,
    private readonly lines: readonly LyricLine[],
  ) {}

  /** Called on every clock update (about 30 a second while playing), seek, pause and resume. */
  update(time: number, paused: boolean): void {
    const at = this.ports.now();
    const expected = this.paused ? this.time : this.time + (at - this.timeAt) / 1000;
    const seeked = this.index !== undefined && Math.abs(time - expected) > SEEK_TOLERANCE_SEC;
    const index = phoneLineAt(this.lines, time);
    this.time = time;
    this.timeAt = at;
    if (index === this.index && paused === this.paused && !seeked) {
      return;
    }
    this.index = index;
    this.paused = paused;
    this.request();
  }

  stop(): void {
    this.cancelPending?.();
    this.cancelPending = null;
  }

  private request(): void {
    const wait = this.lastSentAt + LYRIC_MIN_INTERVAL_MS - this.ports.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.cancelPending ??= this.ports.later(() => {
      this.cancelPending = null;
      this.flush();
    }, wait);
  }

  private flush(): void {
    const at = this.ports.now();
    this.lastSentAt = at;
    const time = this.paused ? this.time : this.time + (at - this.timeAt) / 1000;
    this.ports.send(lyricPayload(this.lines, this.index ?? null, time, this.paused));
  }
}
