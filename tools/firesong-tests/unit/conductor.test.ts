import { describe, expect, it, vi } from 'vitest';

import {
  LobbyConductor,
  START_NO_PROGRESS_MS,
  START_SETTLE_MS,
  type ConductorEntry,
  type ConductorInput,
  type StartPlan,
} from '@/features/party-lobby/conductor';
import type { StageReport } from '@/features/party-lobby/party-store';
import type {
  MicSlot,
  NoticeCode,
  PartyItem,
  PartySinger,
} from '@/features/remote-mic/protocol';

vi.mock('@/i18n', () => ({ t: (key: string) => key }));

const MICS = new Map<MicSlot, string>([
  [1, 'mic-aaaaaaaa'],
  [2, 'mic-bbbbbbbb'],
  [3, 'mic-cccccccc'],
]);

const entry = (id: string, title = `Song ${id}`): ConductorEntry => ({ id, title, artist: 'Artist' });

const item = (entryId: string | undefined, singers: number[], prep: PartyItem['prep'] = { state: 'ready' }): PartyItem => ({
  reservationId: `r${entryId ?? 'x'}`,
  ...(entryId === undefined ? {} : { entryId }),
  fileHash: '535b53bf0c2d4e6f8a9b1c2d3e4f5a6b',
  title: `Song ${entryId ?? 'x'}`,
  artist: 'Artist',
  durationSecs: 200,
  singers,
  keyOffset: 0,
  tempo: 1,
  singNext: false,
  shiftable: true,
  prep,
});

const singer = (slot: MicSlot, state: 'connected' | 'reserved' = 'connected'): PartySinger => ({
  slot,
  color: (['rose', 'fuchsia', 'amber', 'emerald'] as const)[slot - 1],
  name: `Singer ${slot}`,
  state,
  volumePct: 100,
  echoPct: 100,
});

const setup = () => {
  let now = 1_000_000;
  const stages: StageReport[] = [];
  const starts: StartPlan[] = [];
  const moves: [string, number][] = [];
  const removed: string[] = [];
  const notices: [MicSlot, NoticeCode, string][] = [];
  const conductor = new LobbyConductor(
    {
      stage: (report) => stages.push(report),
      start: (plan) => starts.push(plan),
      move: (id, index) => moves.push([id, index]),
      remove: (id) => removed.push(id),
      notify: (slot, code, title) => notices.push([slot, code, title]),
    },
    () => now,
  );
  let input: ConductorInput = {
    autoStart: true,
    idle: true,
    preparing: false,
    entries: [],
    items: [],
    singers: [],
    mics: MICS,
  };
  const set = (patch: Partial<ConductorInput>) => {
    input = { ...input, ...patch };
    conductor.update(input);
  };
  const advance = (ms: number, step = 250) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      now += Math.min(step, ms - elapsed);
      conductor.tick();
    }
  };
  return { conductor, stages, starts, moves, removed, notices, set, advance };
};

describe('lobby countdown', () => {
  it('counts down 15 s for a host song and starts it with no players', () => {
    const { conductor, stages, starts, set, advance } = setup();
    set({ entries: [entry('12')] });
    expect(stages.at(-1)).toEqual({ state: 'lobby', singers: [], countdownSecs: 15 });
    advance(5000);
    expect(conductor.status()).toMatchObject({ kind: 'countdown', secondsLeft: 10 });
    expect(stages.at(-1)?.countdownSecs).toBe(10);
    expect(starts).toEqual([]);
    advance(10_000);
    expect(starts).toEqual([{ entryId: '12', players: [], soloMicrophoneId: null }]);
    expect(stages.at(-1)).toEqual({
      state: 'starting',
      entryId: '12',
      singers: [],
      title: 'Song 12',
      artist: 'Artist',
    });
  });

  it("starts a duet with both phones as players, owner first", () => {
    const { starts, stages, set, advance } = setup();
    set({
      entries: [entry('12')],
      items: [item('12', [2, 1])],
      singers: [singer(1), singer(2)],
    });
    advance(15_000);
    expect(starts).toEqual([
      {
        entryId: '12',
        players: [
          { id: 'slot-2', profile: null, microphoneId: 'remote:mic-bbbbbbbb', color: 'fuchsia' },
          { id: 'slot-1', profile: null, microphoneId: 'remote:mic-aaaaaaaa', color: 'rose' },
        ],
        soloMicrophoneId: null,
      },
    ]);
    expect(stages.at(-1)?.singers).toEqual([2, 1]);
  });

  it("scores a solo song from its owner's phone, not the lowest slot", () => {
    const { starts, set, advance } = setup();
    set({ entries: [entry('7')], items: [item('7', [3])], singers: [singer(1), singer(3)] });
    advance(15_000);
    expect(starts).toEqual([
      { entryId: '7', players: [], soloMicrophoneId: 'remote:mic-cccccccc' },
    ]);
  });

  it('does not count down while the lobby is not on screen, but OK still starts', () => {
    const { conductor, stages, starts, set, advance } = setup();
    set({ autoStart: false, entries: [entry('12')] });
    advance(30_000);
    expect(starts).toEqual([]);
    expect(stages.at(-1)).toEqual({ state: 'lobby', singers: [] });
    expect(conductor.startNow()).toBe(true);
    expect(starts).toHaveLength(1);
    expect(conductor.startNow()).toBe(false);
  });

  it('waits while items only prepare, then counts down for the first ready one', () => {
    const { conductor, starts, set, advance } = setup();
    set({ items: [item(undefined, [1], { state: 'analyzing', pct: 40, etaSecs: 75 })], singers: [singer(1)] });
    advance(60_000);
    expect(conductor.status()).toEqual({ kind: 'empty' });
    expect(starts).toEqual([]);
    set({ entries: [entry('20')], items: [item('20', [1])] });
    expect(conductor.status()).toMatchObject({ kind: 'countdown', secondsLeft: 15 });
  });

  it('starts at once on start-now, but never while a song plays', () => {
    const { conductor, starts, set } = setup();
    set({ idle: false, entries: [entry('12')] });
    expect(conductor.startNow()).toBe(false);
    set({ idle: true });
    expect(conductor.startNow()).toBe(true);
    expect(starts).toHaveLength(1);
  });
});

describe('absent singers', () => {
  it('waits 30 s for a reconnecting owner, then passes the item over exactly once', () => {
    const { conductor, moves, notices, starts, set, advance } = setup();
    set({
      entries: [entry('1', 'Creep'), entry('2')],
      items: [item('1', [3]), item('2', [1])],
      singers: [singer(1), singer(3, 'reserved')],
    });
    expect(conductor.status()).toMatchObject({ kind: 'waiting', owner: 3, secondsLeft: 30 });
    advance(29_000);
    expect(moves).toEqual([]);
    advance(1000);
    expect(moves).toEqual([['1', 1]]);
    expect(notices).toEqual([[3, 'passed-over', 'Creep']]);

    // The queue now has the other item first.
    set({ entries: [entry('2'), entry('1', 'Creep')] });
    advance(15_000);
    expect(starts.map((plan) => plan.entryId)).toEqual(['2']);

    // Song 2 played; back in the lobby with Creep first and its owner still away.
    set({ idle: false });
    set({ idle: true, entries: [entry('1', 'Creep'), entry('3')], items: [item('1', [3]), item('3', [])] });
    advance(30_000);
    expect(moves).toEqual([['1', 1]]);
    expect(conductor.status()).toMatchObject({ kind: 'countdown' });
    advance(15_000);
    expect(starts.map((plan) => plan.entryId)).toEqual(['2', '1']);
    expect(notices).toHaveLength(1);
  });

  it('keeps waiting when nothing else is ready, and counts down as soon as the owner is back', () => {
    const { conductor, moves, starts, set, advance } = setup();
    set({ entries: [entry('1')], items: [item('1', [2])], singers: [singer(2, 'reserved')] });
    advance(120_000);
    expect(moves).toEqual([]);
    expect(starts).toEqual([]);
    expect(conductor.status()).toMatchObject({ kind: 'waiting', secondsLeft: null });
    set({ singers: [singer(2)] });
    expect(conductor.status()).toMatchObject({ kind: 'countdown', secondsLeft: 15 });
  });
});

describe('songs that cannot start', () => {
  it('removes the entry and tells its owner when the start stops with the entry still queued', () => {
    const { removed, notices, set, advance } = setup();
    set({ entries: [entry('5', 'Wonderwall')], items: [item('5', [1])], singers: [singer(1)] });
    advance(15_000);
    set({ preparing: true });
    advance(10_000);
    set({ preparing: false });
    advance(START_SETTLE_MS - 250);
    expect(removed).toEqual([]);
    advance(500);
    expect(removed).toEqual(['5']);
    expect(notices).toEqual([[1, 'start-failed', 'Wonderwall']]);
  });

  it('treats a start that never began as failed', () => {
    const { removed, set, advance } = setup();
    set({ entries: [entry('5')] });
    advance(15_000);
    advance(START_NO_PROGRESS_MS);
    expect(removed).toEqual(['5']);
  });

  it('counts a start as done once the entry left the queue or the song opened', () => {
    const { conductor, removed, set, advance } = setup();
    set({ entries: [entry('5'), entry('6')] });
    advance(15_000);
    set({ preparing: true });
    set({ preparing: false, entries: [entry('6')] });
    advance(START_NO_PROGRESS_MS * 2);
    expect(removed).toEqual([]);
    expect(conductor.status()).toMatchObject({ kind: 'countdown' });
  });
});
