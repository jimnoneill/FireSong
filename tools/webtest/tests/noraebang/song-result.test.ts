import { afterEach, describe, expect, it, vi } from 'vitest';

import { noraebangScore } from '@/features/noraebang/score';
import {
  buildSongResultFrame,
  publishSongResult,
  registerSongResultSink,
  type SongResultEntry,
} from '@/features/noraebang/song-result';
import type { MicSlot, TvToServer } from '@/features/remote-mic/protocol';

const SLOTS = new Map<string, MicSlot>([
  ['remote:mic-aaaa-1111', 2],
  ['remote:mic-bbbb-2222', 1],
]);
const slotFor = (id: string) => SLOTS.get(id) ?? null;

const entry = (microphoneId: string | null, rawScore: number, rank: number): SongResultEntry => ({
  microphoneId,
  score: noraebangScore({ rawScore, voicedRatio: 0.9 }),
  rank,
});

describe('song-result frame', () => {
  it('sends phone singers their own slot result and skips local mics', () => {
    const frame = buildSongResultFrame(
      '  Sunset Song  ',
      [
        entry('remote:mic-aaaa-1111', 700, 1),
        entry('default', 500, 2),
        entry('remote:mic-bbbb-2222', 300, 3),
        entry(null, 100, 4),
      ],
      slotFor,
    );
    expect(frame).toEqual({
      type: 'song-result',
      title: 'Sunset Song',
      results: [
        { slot: 2, displayScore: 100, rawScore: 700, tier: 'perfect', rank: 1 },
        { slot: 1, displayScore: 88, rawScore: 300, tier: 'great', rank: 3 },
      ],
    });
  });

  it('returns null without phone singers and drops a second entry for one slot', () => {
    expect(buildSongResultFrame('x', [entry('default', 500, 1)], slotFor)).toBeNull();
    const frame = buildSongResultFrame(
      '',
      [entry('remote:mic-aaaa-1111', 700, 1), entry('remote:mic-aaaa-1111', 100, 2)],
      slotFor,
    );
    expect(frame).toEqual({
      type: 'song-result',
      results: [{ slot: 2, displayScore: 100, rawScore: 700, tier: 'perfect', rank: 1 }],
    });
  });

  it('cuts the title to 200 code points without splitting characters', () => {
    const frame = buildSongResultFrame(
      '🎤'.repeat(250),
      [entry('remote:mic-aaaa-1111', 1, 1)],
      slotFor,
    );
    expect(frame?.type === 'song-result' ? Array.from(frame.title ?? '') : []).toHaveLength(200);
  });
});

describe('song-result sink', () => {
  let unregister: (() => void) | null = null;
  afterEach(() => unregister?.());

  it('is a no-op until the TV socket registers, then sends through it', () => {
    expect(publishSongResult('t', [entry('remote:mic-aaaa-1111', 500, 1)])).toBe(false);

    const send = vi.fn<(frame: TvToServer) => void>();
    const release = registerSongResultSink({ send, slotForMicrophone: slotFor });
    unregister = release;
    expect(publishSongResult('t', [entry('remote:mic-aaaa-1111', 500, 1)])).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ type: 'song-result', title: 't' });

    release();
    expect(publishSongResult('t', [entry('remote:mic-aaaa-1111', 500, 1)])).toBe(false);
  });
});
