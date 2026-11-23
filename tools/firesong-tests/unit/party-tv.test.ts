import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TvPartyEvent } from '@/bridge/remote-mics';
import { lobbyModel } from '@/features/party-lobby/lobby-model';
import { cleanStage, PartyTv, wireText } from '@/features/party-lobby/party-store';
import { PhoneCalibrator } from '@/features/remote-mic/phone-calibration';
import type {
  FxSound,
  LatencyMethod,
  MicSlot,
  PartySnapshot,
  TvPartyToServer,
} from '@/features/remote-mic/protocol';

vi.mock('@/i18n', () => ({ t: (key: string) => key }));

const synth = vi.hoisted(() => ({ played: [] as string[], refuse: false }));
const latency = vi.hoisted(() => ({ result: 0.212 as number | Error }));

vi.mock('@/audio/fx-synth', () => ({
  createFxSynth: () => ({
    play: (sound: string) => {
      if (synth.refuse) {
        return false;
      }
      synth.played.push(sound);
      return true;
    },
    playing: () => 0,
  }),
}));
vi.mock('@/audio/voice-engine', () => ({ getVoiceEngine: () => ({ context: {}, output: {} }) }));
vi.mock('@/bridge/microphone', () => ({ microphoneAdapter: {} }));
vi.mock('@/features/microphone/lib/latency-test', () => ({
  measureMicLatencySec: async () => {
    if (latency.result instanceof Error) {
      throw latency.result;
    }
    return latency.result;
  },
}));

const MIC_A = 'mic-aaaaaaaa';

const snapshot = (patch: Partial<PartySnapshot> = {}): PartySnapshot => ({
  rev: 1,
  tvConnected: true,
  stage: { state: 'lobby', singers: [] },
  queue: [],
  queueTotal: 0,
  singers: [],
  scores: [],
  ...patch,
});

describe('party store', () => {
  it('sends stage only when it changes, and again after the seat is taken again', () => {
    const store = new PartyTv({ setTimeout: () => undefined });
    const sent: TvPartyToServer[] = [];
    store.attachSink({ send: (frame) => (sent.push(frame), true) });
    store.reportStage({ state: 'lobby', singers: [], countdownSecs: 15 });
    store.reportStage({ state: 'lobby', singers: [], countdownSecs: 15 });
    store.reportStage({ state: 'lobby', singers: [], countdownSecs: 14 });
    expect(sent).toEqual([
      { type: 'stage', state: 'lobby', singers: [], countdownSecs: 15 },
      { type: 'stage', state: 'lobby', singers: [], countdownSecs: 14 },
    ]);
    store.onReady();
    expect(sent).toHaveLength(3);
  });

  it('cleans stage and texts for the wire', () => {
    expect(
      cleanStage({
        state: 'singing',
        entryId: 'not a valid id!',
        singers: [2, 2, 9, 1],
        title: `  ${'x'.repeat(250)}`,
        artist: '',
        countdownSecs: 500,
      }),
    ).toEqual({ state: 'singing', singers: [2, 1], title: 'x'.repeat(200), countdownSecs: 120 });
    expect(wireText('a\u0007b\nc 🎤', 200)).toBe('a b c 🎤');
    expect(Array.from(wireText('😀'.repeat(300), 200))).toHaveLength(200);
  });

  it('routes the phone remote to the playing song and start-now to the lobby', () => {
    const store = new PartyTv({ setTimeout: () => undefined });
    const sent: TvPartyToServer[] = [];
    store.attachSink({ send: (frame) => (sent.push(frame), true) });
    const calls: string[] = [];
    store.shiftCurrent(2, -2, 1.1);
    expect(sent).toEqual([{ type: 'notify', slot: 2, code: 'shift-failed' }]);
    const unregister = store.registerPlayback({
      pause: () => calls.push('pause'),
      resume: () => calls.push('resume'),
      stop: () => calls.push('stop'),
      shift: (slot, key, tempo) => calls.push(`shift:${slot}:${key}:${tempo}`),
    });
    store.registerLobby({ startNow: () => calls.push('start-now') });
    store.control('pause');
    store.control('resume');
    store.shiftCurrent(1, 3, 0.9);
    store.control('stop');
    store.control('start-now');
    expect(calls).toEqual(['pause', 'resume', 'shift:1:3:0.9', 'stop', 'start-now']);
    unregister();
    store.control('pause');
    expect(calls).toHaveLength(5);
    expect(store.getState().songs).toBe(1);
  });
});

describe('party link', () => {
  beforeEach(() => {
    synth.played.length = 0;
    synth.refuse = false;
  });

  const link = async () => {
    const { linkParty } = await import('@/features/remote-mic/party-link');
    const { partyTv } = await import('@/features/party-lobby/party-store');
    const sent: TvPartyToServer[] = [];
    const latencies: [string, number, LatencyMethod][] = [];
    let listener: (event: TvPartyEvent) => void = () => undefined;
    const attached = new Set<number>([3]);
    const mics = {
      sendParty: (frame: TvPartyToServer) => (sent.push(frame), true),
      subscribeParty: (next: (event: TvPartyEvent) => void) => {
        listener = next;
        return () => undefined;
      },
      reportLatency: (micId: string, ms: number, method: LatencyMethod) =>
        (latencies.push([micId, ms, method]), true),
      slotStatus: (slot: number) => (attached.has(slot) ? { attached: true } : null),
      backendSample: () => ({ kind: 'web', why: 'not-requested' }),
      calibrationOutput: () => ({ context: {}, destination: {} }),
      slotForMicrophone: () => 3,
    };
    // The link only uses these members of RemoteMics.
    const unlink = linkParty(mics as never);
    return { partyTv, sent, latencies, emit: (event: TvPartyEvent) => listener(event), unlink };
  };

  it('plays fun sounds, flashes the sender and counts what the voice limit dropped', async () => {
    const { partyTv, emit, unlink } = await link();
    const sounds: FxSound[] = ['applause', 'air-horn'];
    for (const sound of sounds) {
      emit({ kind: 'frame', frame: { type: 'fx', slot: 2, sound } });
    }
    synth.refuse = true;
    emit({ kind: 'frame', frame: { type: 'fx', slot: 4, sound: 'cheer' } });
    expect(synth.played).toEqual(['applause', 'air-horn']);
    expect(partyTv.getState().flashes.map(({ slot, sound }) => [slot, sound])).toEqual([
      [2, 'applause'],
      [2, 'air-horn'],
    ]);
    expect(partyTv.fxCounters()).toEqual({ played: 2, dropped: 1 });
    unlink();
  });

  it('keeps the latest snapshot and reports the stage when the seat is taken', async () => {
    const { partyTv, emit, sent, unlink } = await link();
    emit({ kind: 'frame', frame: { type: 'party', party: snapshot({ rev: 4 }) } });
    expect(partyTv.getState().snapshot?.rev).toBe(4);
    emit({ kind: 'ready' });
    expect(sent.filter((frame) => frame.type === 'stage')).toHaveLength(1);
    unlink();
    expect(partyTv.getState().snapshot).toBeNull();
  });

  it('runs a phone-started calibration on the voice engine and stores the result', async () => {
    latency.result = 0.2124;
    const { emit, sent, latencies, unlink } = await link();
    emit({ kind: 'frame', frame: { type: 'calibrate', slot: 3, micId: MIC_A } });
    await vi.waitFor(() => expect(sent.at(-1)).toMatchObject({ type: 'calibration', state: 'done' }), {
      timeout: 3000,
    });
    expect(sent.filter((frame) => frame.type === 'calibration')).toEqual([
      { type: 'calibration', slot: 3, state: 'started' },
      { type: 'calibration', slot: 3, state: 'done', latencyMs: 212 },
    ]);
    expect(latencies).toEqual([[MIC_A, 212, 'beep']]);
    unlink();
  });
});

describe('phone calibrator', () => {
  const calibrator = (overrides: { idle?: boolean; hasAudio?: boolean; measure?: () => Promise<number> } = {}) => {
    const sent: TvPartyToServer[] = [];
    const tuning: (MicSlot | null)[] = [];
    const runner = new PhoneCalibrator({
      measure: overrides.measure ?? (async () => 0.18),
      send: (frame) => (sent.push(frame), true),
      reportLatency: () => true,
      hasAudio: () => overrides.hasAudio ?? true,
      idle: () => overrides.idle ?? true,
      setTuning: (slot) => tuning.push(slot),
      settle: async () => undefined,
    });
    return { runner, sent, tuning };
  };

  it('is busy while a song is on, and while another calibration runs', async () => {
    const song = calibrator({ idle: false });
    song.runner.run(1, MIC_A);
    expect(song.sent).toEqual([{ type: 'calibration', slot: 1, state: 'failed', reason: 'busy' }]);

    let finish: (seconds: number) => void = () => undefined;
    const twice = calibrator({ measure: () => new Promise((resolve) => (finish = resolve)) });
    twice.runner.run(1, MIC_A);
    twice.runner.run(2, MIC_A);
    expect(twice.sent).toEqual([
      { type: 'calibration', slot: 1, state: 'started' },
      { type: 'calibration', slot: 2, state: 'failed', reason: 'busy' },
    ]);
    await vi.waitFor(() => expect(twice.runner.isRunning()).toBe(true));
    finish(0.1);
    await vi.waitFor(() => expect(twice.runner.isRunning()).toBe(false));
    expect(twice.tuning).toEqual([1, null]);
  });

  it('reports no-audio without a stream and no-tone when the beep is not heard', async () => {
    const silent = calibrator({ hasAudio: false });
    silent.runner.run(1, MIC_A);
    expect(silent.sent).toEqual([
      { type: 'calibration', slot: 1, state: 'failed', reason: 'no-audio' },
    ]);
    const deaf = calibrator({ measure: async () => Promise.reject(new Error('no tone')) });
    deaf.runner.run(4, MIC_A);
    await vi.waitFor(() => expect(deaf.sent).toHaveLength(2));
    expect(deaf.sent[1]).toEqual({ type: 'calibration', slot: 4, state: 'failed', reason: 'no-tone' });
  });
});

describe('lobby model', () => {
  it('lists up next from the party queue with singer names, else the upstream queue', () => {
    const party = snapshot({
      queue: [
        {
          reservationId: 'r4',
          entryId: '12',
          fileHash: '535b53bf0c2d4e6f8a9b1c2d3e4f5a6b',
          title: 'Wonderwall',
          artist: 'Oasis',
          durationSecs: 258.5,
          singers: [2, 1],
          keyOffset: -2,
          tempo: 1,
          singNext: false,
          shiftable: true,
          prep: { state: 'ready' },
        },
      ],
      queueTotal: 7,
      singers: [
        { slot: 1, color: 'rose', name: 'Jim', state: 'connected', volumePct: 100, echoPct: 100 },
        { slot: 2, color: 'fuchsia', state: 'reserved', volumePct: 100, echoPct: 100 },
      ],
    });
    const model = lobbyModel({ snapshot: party, entries: [], links: [], devices: [] });
    expect(model.upNext[0].singers.map(({ slot, name, reconnecting }) => [slot, name, reconnecting])).toEqual([
      [2, null, true],
      [1, 'Jim', false],
    ]);
    expect(model.more).toBe(6);
    expect(model.slots.map((slot) => slot.singer?.name ?? '-')).toEqual(['Jim', '-', '-', '-']);

    const plain = lobbyModel({
      snapshot: null,
      entries: [{ id: '3', title: 'Creep', artist: 'Radiohead' }],
      links: [],
      devices: [],
    });
    expect(plain.upNext).toEqual([
      { key: '3', title: 'Creep', artist: 'Radiohead', singers: [], prep: { state: 'ready' } },
    ]);
  });
});
