import { describe, expect, it, vi } from 'vitest';

import {
  LYRIC_MIN_INTERVAL_MS,
  LyricLineSender,
  phoneLineAt,
  type LyricLine,
  type LyricPayload,
} from '@/features/party-lobby/lyric-sender';

vi.mock('@/i18n', () => ({ t: (key: string) => key }));

/** Four lines in one verse, a 10 s gap, then a verse of quick 0.3 s lines. */
const LINES: LyricLine[] = [
  { text: 'one', start: 10, end: 12 },
  { text: 'two', start: 12.2, end: 14 },
  { text: 'three', start: 14.5, end: 16.5 },
  { text: 'four', start: 16.6, end: 18 },
  ...Array.from({ length: 20 }, (_, index) => ({
    text: `quick ${index}`,
    start: 28 + index * 0.3,
    end: 28.28 + index * 0.3,
  })),
];

/** Plays the song on a fake clock at 30 updates a second, as the transport notifies. */
const run = () => {
  let wall = 0;
  let pending: { at: number; fn: () => void } | null = null;
  const sent: { at: number; frame: LyricPayload }[] = [];
  const sender = new LyricLineSender(
    {
      send: (frame) => sent.push({ at: wall, frame }),
      now: () => wall,
      later: (fn, ms) => {
        pending = { at: wall + ms, fn };
        return () => {
          pending = null;
        };
      },
    },
    LINES,
  );
  let media = 0;
  let paused = false;
  const play = (seconds: number) => {
    const steps = Math.round(seconds * 30);
    for (let step = 0; step < steps; step += 1) {
      wall += 1000 / 30;
      if (!paused) {
        media += 1 / 30;
      }
      const due = pending;
      if (due !== null && due.at <= wall) {
        pending = null;
        due.fn();
      }
      if (!paused) {
        sender.update(media, paused);
      }
    }
  };
  return {
    sent,
    play,
    pause: () => {
      paused = true;
      sender.update(media, true);
    },
    resume: () => {
      paused = false;
      sender.update(media, false);
    },
    seek: (to: number) => {
      media = to;
      sender.update(media, paused);
    },
  };
};

describe('phoneLineAt', () => {
  it('shows a line from its start until the next line of its verse, nothing between verses', () => {
    expect(phoneLineAt(LINES, 9)).toBeNull();
    expect(phoneLineAt(LINES, 10)).toBe(0);
    expect(phoneLineAt(LINES, 12.1)).toBe(0);
    expect(phoneLineAt(LINES, 14.3)).toBe(1);
    expect(phoneLineAt(LINES, 18.2)).toBe(3);
    expect(phoneLineAt(LINES, 20)).toBeNull();
    expect(phoneLineAt(LINES, 28.1)).toBe(4);
  });
});

describe('lyric sender', () => {
  it('sends on line changes only, at most two frames a second', () => {
    const song = run();
    song.play(40);
    const times = song.sent.map(({ at }) => at);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index] - times[index - 1]).toBeGreaterThanOrEqual(LYRIC_MIN_INTERVAL_MS);
    }
    for (let second = 0; second < 40; second += 1) {
      const inSecond = times.filter((at) => at >= second * 1000 && at < (second + 1) * 1000);
      expect(inSecond.length).toBeLessThanOrEqual(2);
    }
    // 1 (nothing yet) + 4 lines + clear + the quick verse coalesced + clear: far below 30 per second.
    expect(song.sent.length).toBeLessThan(25);
    expect(song.sent[0].frame).toEqual({ paused: false });
    const first = song.sent[1].frame;
    expect(first).toMatchObject({ line: 'one', next: 'two', lineMs: 2000, paused: false });
    expect(first.elapsedMs).toBeLessThan(100);
    expect(song.sent.some(({ frame }) => frame.line === 'four' && frame.next === 'quick 0')).toBe(
      true,
    );
    expect(song.sent.at(-1)?.frame).toEqual({ paused: false });
  });

  it('sends on pause, resume and seek, with the elapsed time of the line', () => {
    const song = run();
    song.play(11);
    const before = song.sent.length;
    song.play(0.5);
    expect(song.sent.length).toBe(before);
    song.pause();
    expect(song.sent.at(-1)?.frame).toMatchObject({ line: 'one', paused: true });
    expect(song.sent.at(-1)?.frame.elapsedMs).toBeGreaterThan(1300);
    song.play(5);
    expect(song.sent.length).toBe(before + 1);
    song.resume();
    song.play(0.6);
    expect(song.sent.at(-1)?.frame).toMatchObject({ line: 'one', paused: false });
    song.seek(15);
    song.play(0.6);
    expect(song.sent.at(-1)?.frame).toMatchObject({ line: 'three', next: 'four' });
    expect(song.sent.at(-1)?.frame.elapsedMs).toBeGreaterThan(400);
    // Back to the start of the same line: no line change, but a seek.
    const afterSeek = song.sent.length;
    song.seek(14.6);
    song.play(0.3);
    expect(song.sent.length).toBe(afterSeek + 1);
    expect(song.sent.at(-1)?.frame).toMatchObject({ line: 'three' });
    expect(song.sent.at(-1)?.frame.elapsedMs).toBeLessThan(200);
  });
});
