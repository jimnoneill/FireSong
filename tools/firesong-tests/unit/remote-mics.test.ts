import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MicRackPort, TapListener } from '@/audio/mic-rack';
import { DEFAULT_ECHO_MIX, type EchoMix, type SlotMix } from '@/audio/voice-params';
import type { MicBackend } from '@/bridge/mic-backend';
import type { PeerEvents, PeerInit, PeerPort } from '@/bridge/remote-mic-peer';
import { RemoteMics, type RemoteMicsDeps } from '@/bridge/remote-mics';
import { phoneCalibration } from '@/features/remote-mic/calibration';
import type {
  ServerToTv,
  ServerToTvParty,
  TvPartyToServer,
  TvSlot,
  TvToServer,
} from '@/features/remote-mic/protocol';
import type { MicSampleFrame } from '@/types/MicSampleFrame';

vi.mock('@/i18n', () => ({
  t: (key: string, values?: Record<string, unknown>) =>
    values === undefined ? key : `${key}${JSON.stringify(values)}`,
}));

const MIC_A = 'mic-aaaaaaaa';
const MIC_B = 'mic-bbbbbbbb';

class FakeRack implements MicRackPort {
  readonly calls: string[] = [];
  readonly taps = new Map<number, TapListener | null>();
  readonly monitors = new Map<number, boolean>();
  readonly latencies = new Map<number, number | null>();
  readonly muted = new Map<number, boolean>();
  readonly streams = new Map<number, MediaStream>();
  readonly mixes: EchoMix[] = [];
  readonly slotMixes = new Map<number, SlotMix>();

  attach(slot: 1 | 2 | 3 | 4, stream: MediaStream) {
    this.calls.push(`attach:${slot}`);
    this.streams.set(slot, stream);
  }
  detach(slot: number) {
    this.calls.push(`detach:${slot}`);
    this.streams.delete(slot);
  }
  release(slot: number) {
    if (this.taps.has(slot) || this.streams.has(slot) || this.monitors.has(slot)) {
      this.calls.push(`release:${slot}`);
    }
    this.taps.delete(slot);
    this.streams.delete(slot);
    this.monitors.delete(slot);
  }
  setTap(slot: number, listener: TapListener | null) {
    this.calls.push(`tap:${slot}:${listener === null ? 'off' : 'on'}`);
    this.taps.set(slot, listener);
  }
  setMonitor(slot: number, on: boolean) {
    this.monitors.set(slot, on);
  }
  setMuted(slot: number, muted: boolean) {
    this.muted.set(slot, muted);
  }
  setLatency(slot: number, latencyMs: number | null) {
    this.latencies.set(slot, latencyMs);
  }
  setEchoMix(mix: EchoMix) {
    this.mixes.push(mix);
  }
  setSlotMix(slot: number, mix: SlotMix) {
    this.slotMixes.set(slot, mix);
  }
  status() {
    return null;
  }
}

class FakePeer implements PeerPort {
  readonly micId: string;
  readonly events: PeerEvents;
  readonly offers: string[] = [];
  readonly ice: unknown[] = [];
  closed = false;

  constructor(init: PeerInit) {
    this.micId = init.micId;
    this.events = init.events;
  }
  async acceptOffer(sdp: string) {
    this.offers.push(sdp);
    this.events.onAnswer(`answer-to-${sdp}`);
  }
  addIce(candidate: unknown) {
    this.ice.push(candidate);
  }
  close() {
    this.closed = true;
  }
}

const webBackend = (rack: MicRackPort, createPeer: (init: PeerInit) => PeerPort): MicBackend => ({
  kind: 'web',
  why: 'not-requested',
  rack,
  createPeer,
  calibrationOutput: () => {
    throw new Error('no audio output in unit tests');
  },
  measureMonitor: async () => null,
  onLost: () => () => undefined,
  flightSample: () => ({ kind: 'web' }),
  close: () => undefined,
});

const slot = (n: 1 | 2 | 3 | 4, extra: Partial<TvSlot> = {}): TvSlot => ({
  slot: n,
  color: (['rose', 'fuchsia', 'amber', 'emerald'] as const)[n - 1],
  state: 'empty',
  muted: false,
  ...extra,
});

const roster = (...active: TvSlot[]): ServerToTv => ({
  type: 'roster',
  slots: ([1, 2, 3, 4] as const).map((n) => active.find((s) => s.slot === n) ?? slot(n)),
});

const settings = { monitorAlways: false, mix: DEFAULT_ECHO_MIX };

const setup = (monitorAlways = false) => {
  settings.monitorAlways = monitorAlways;
  settings.mix = DEFAULT_ECHO_MIX;
  const rack = new FakeRack();
  const sent: (TvToServer | TvPartyToServer)[] = [];
  const peers: FakePeer[] = [];
  const frames: [string, MicSampleFrame][] = [];
  let push: (frame: ServerToTv | ServerToTvParty) => void = () => undefined;
  let stopped = 0;
  const deviceChanges = vi.fn();
  const createPeer = (init: PeerInit) => {
    const peer = new FakePeer(init);
    peers.push(peer);
    return peer;
  };
  const deps: RemoteMicsDeps = {
    backend: async () => webBackend(rack, createPeer),
    fallback: async () => webBackend(rack, createPeer),
    connect: (onFrame, onOpen) => {
      push = onFrame;
      onOpen(true);
      return {
        send: (frame) => {
          sent.push(frame);
          return true;
        },
        stop: () => {
          stopped += 1;
        },
      };
    },
    dispatchFrame: (captureId, frame) => frames.push([captureId, frame]),
    devicesChanged: deviceChanges,
    label: (entry) => `Slot ${entry.slot} · ${entry.name ?? entry.color}${entry.state === 'reserved' ? ' (reconnecting)' : ''}`,
    monitorAlways: () => settings.monitorAlways,
    echoMix: () => settings.mix,
  };
  const mics = new RemoteMics(deps);
  return {
    mics,
    rack,
    sent,
    peers,
    frames,
    deviceChanges,
    push: (frame: ServerToTv | ServerToTvParty) => push(frame),
    stopped: () => stopped,
  };
};

const started = async (monitorAlways = false) => {
  const harness = setup(monitorAlways);
  const stop = harness.mics.start();
  await vi.waitFor(() => expect(harness.mics.getSnapshot().connected).toBe(true));
  return { ...harness, stop };
};

beforeEach(() => {
  vi.useRealTimers();
});

describe('roster and devices', () => {
  it('lists connected and reserved slots as remote devices and fires devicechange', async () => {
    const { mics, push, deviceChanges } = await started();
    push({ type: 'ready', v: 1, iceServers: [] });
    push(roster(slot(2, { state: 'connected', micId: MIC_A, name: 'Jim' })));
    expect(mics.devices()).toEqual([
      { id: `remote:${MIC_A}`, micId: MIC_A, slot: 2, label: 'Slot 2 · Jim', reconnecting: false },
    ]);
    expect(deviceChanges).toHaveBeenCalledTimes(1);

    push(roster(slot(2, { state: 'connected', micId: MIC_A, name: 'Jim' })));
    expect(deviceChanges).toHaveBeenCalledTimes(1);

    push(roster(slot(2, { state: 'reserved', micId: MIC_A, name: 'Jim' })));
    expect(mics.devices()[0]).toMatchObject({ reconnecting: true, label: 'Slot 2 · Jim (reconnecting)' });
    expect(deviceChanges).toHaveBeenCalledTimes(2);

    push(roster());
    expect(mics.devices()).toEqual([]);
    expect(deviceChanges).toHaveBeenCalledTimes(3);
  });

  it('exposes calibrated latency per mic only', async () => {
    const { mics, push, rack } = await started();
    push(
      roster(
        slot(1, { state: 'connected', micId: MIC_A, latencyMs: 180, latencyMethod: 'beep' }),
        slot(3, { state: 'connected', micId: MIC_B }),
      ),
    );
    expect([...mics.getSnapshot().latencyMs]).toEqual([[MIC_A, 180]]);
    expect(rack.latencies.get(1)).toBe(180);
    expect(rack.latencies.get(3)).toBeNull();
  });
});

describe('capture bindings', () => {
  it('taps the slot while a capture id is bound and fans frames out', async () => {
    const { mics, push, rack, frames } = await started();
    push(roster(slot(1, { state: 'connected', micId: MIC_A })));
    mics.bind('player-1', MIC_A, false);
    mics.bind('player-2', MIC_A, false);
    expect(rack.calls.filter((call) => call.startsWith('tap'))).toEqual(['tap:1:on']);
    expect(rack.calls.some((call) => call.startsWith('learn'))).toBe(false);

    rack.taps.get(1)?.(new Float32Array(512).fill(0.25), 48_000);
    expect(frames.map(([id]) => id)).toEqual(['player-1', 'player-2']);
    expect(frames[0][1].sample_rate).toBe(48_000);
    expect(frames[0][1].samples).toHaveLength(512);

    expect(mics.unbind('player-1')).toBe(true);
    expect(rack.taps.get(1)).not.toBeNull();
    expect(mics.unbind('player-2')).toBe(true);
    expect(rack.taps.get(1)).toBeNull();
    expect(mics.unbind('player-2')).toBe(false);
    expect(rack.calls).not.toContain('detach:1');
  });

  it('binds a mic before it joins and starts frames once it does', async () => {
    const { mics, push, rack } = await started();
    mics.bind('player-1', MIC_B, true);
    expect(rack.taps.size).toBe(0);
    push(roster(slot(4, { state: 'connected', micId: MIC_B })));
    expect(rack.taps.get(4)).not.toBeNull();
    expect(rack.monitors.get(4)).toBe(true);
  });

  it('monitors only when a binding asks, unless noraebang keeps it always on', async () => {
    const follow = await started(false);
    follow.push(roster(slot(1, { state: 'connected', micId: MIC_A })));
    expect(follow.rack.monitors.get(1)).toBe(false);
    follow.mics.bind('p', MIC_A, false);
    expect(follow.mics.setMonitoring('p', true)).toBe(true);
    expect(follow.rack.monitors.get(1)).toBe(true);
    expect(follow.mics.setMonitoring('local', true)).toBe(false);

    const always = await started(true);
    always.push(roster(slot(1, { state: 'connected', micId: MIC_A })));
    expect(always.rack.monitors.get(1)).toBe(true);
  });
});

describe('peers', () => {
  it('answers an offer with a new receive-only peer and attaches its stream', async () => {
    const { push, peers, sent, rack } = await started();
    push({ type: 'ready', v: 1, iceServers: [{ urls: ['stun:example'] }] });
    push(roster(slot(2, { state: 'connected', micId: MIC_A })));
    push({ type: 'offer', slot: 2, micId: MIC_A, sdp: 'o1', restart: false });
    await vi.waitFor(() => expect(sent).toContainEqual({ type: 'answer', slot: 2, sdp: 'answer-to-o1' }));
    expect(peers).toHaveLength(1);

    const stream = { id: 'stream' } as unknown as MediaStream;
    peers[0].events.onStream(stream);
    expect(rack.streams.get(2)).toBe(stream);

    push({ type: 'ice', slot: 2, micId: MIC_A, candidate: null });
    push({ type: 'ice', slot: 2, micId: MIC_B, candidate: null });
    expect(peers[0].ice).toEqual([null]);

    peers[0].events.onRestartNeeded();
    expect(sent).toContainEqual({ type: 'restart', slot: 2 });
  });

  it('renegotiates an ICE restart on the same peer and replaces it otherwise', async () => {
    const { push, peers } = await started();
    push(roster(slot(1, { state: 'connected', micId: MIC_A })));
    push({ type: 'offer', slot: 1, micId: MIC_A, sdp: 'o1', restart: false });
    push({ type: 'offer', slot: 1, micId: MIC_A, sdp: 'o2', restart: true });
    expect(peers).toHaveLength(1);
    expect(peers[0].offers).toEqual(['o1', 'o2']);
    push({ type: 'offer', slot: 1, micId: MIC_A, sdp: 'o3', restart: false });
    expect(peers).toHaveLength(2);
    expect(peers[0].closed).toBe(true);
  });

  it('keeps the strip on disconnect and releases it when the slot is freed', async () => {
    const { push, rack, peers, mics } = await started();
    push(roster(slot(1, { state: 'connected', micId: MIC_A })));
    mics.bind('p', MIC_A, false);
    push({ type: 'offer', slot: 1, micId: MIC_A, sdp: 'o1', restart: false });
    peers[0].events.onStream({} as MediaStream);

    push({ type: 'slot-lost', slot: 1, micId: MIC_A, reason: 'disconnected' });
    expect(peers[0].closed).toBe(true);
    expect(rack.calls).toContain('detach:1');
    expect(rack.calls).not.toContain('release:1');

    push({ type: 'slot-lost', slot: 1, micId: MIC_A, reason: 'expired' });
    expect(rack.calls).toContain('release:1');
  });

  it('follows jitter-buffer drift between calibrations', async () => {
    const { push, peers, rack, mics } = await started();
    push(roster(slot(1, { state: 'connected', micId: MIC_A, latencyMs: 150 })));
    push({ type: 'offer', slot: 1, micId: MIC_A, sdp: 'o1', restart: false });
    const stats = (jitterMs: number) =>
      peers[0].events.onStats({
        jitterMs,
        jitterBufferTargetMs: null,
        packetsReceived: 0,
        packetsLost: 0,
      });
    stats(30);
    stats(62);
    expect(rack.latencies.get(1)).toBe(182);
    expect(mics.getSnapshot().latencyMs.get(MIC_A)).toBe(182);
  });
});

describe('host actions and lifecycle', () => {
  it('reports latency, mutes and kicks through the socket', async () => {
    const { mics, push, sent, rack } = await started();
    push(roster(slot(3, { state: 'connected', micId: MIC_A })));
    expect(mics.reportLatency(MIC_A, 175, 'beep')).toBe(true);
    expect(mics.reportLatency(MIC_B, 175, 'beep')).toBe(false);
    mics.setHostMute(3, true);
    mics.kick(3);
    expect(sent).toEqual([
      { type: 'latency', slot: 3, latencyMs: 175, method: 'beep' },
      { type: 'mute', slot: 3, muted: true },
      { type: 'kick', slot: 3 },
    ]);
    push({ type: 'mute', slot: 3, muted: true, by: 'tv' });
    expect(rack.muted.get(3)).toBe(true);
  });

  it("turns a phone's beep test into its scoring and echo latency", async () => {
    const { mics, push, sent, rack } = await started();
    push(roster(slot(3, { state: 'connected', micId: MIC_A })));
    expect(mics.getSnapshot().latencyMs.has(MIC_A)).toBe(false);
    expect(phoneCalibration(mics, `remote:${MIC_A}`, 0.1824)).toBe('saved');
    expect(sent).toEqual([{ type: 'latency', slot: 3, latencyMs: 182, method: 'beep' }]);
    // The server stores it and echoes it in the roster (PROTOCOL.md §5.2).
    push(roster(slot(3, { state: 'connected', micId: MIC_A, latencyMs: 182, latencyMethod: 'beep' })));
    expect(mics.getSnapshot().latencyMs.get(MIC_A)).toBe(182);
    expect(rack.latencies.get(3)).toBe(182);
  });

  it('records server errors', async () => {
    const { mics, push } = await started();
    push({ type: 'error', code: 'tv-replaced' });
    expect(mics.getSnapshot().lastError).toBe('tv-replaced');
  });

  it('survives a start/stop/start (React StrictMode) without reconnecting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const harness = setup();
    const stopFirst = harness.mics.start();
    await vi.waitFor(() => expect(harness.mics.getSnapshot().connected).toBe(true));
    stopFirst();
    stopFirst();
    const stopSecond = harness.mics.start();
    vi.runAllTimers();
    expect(harness.stopped()).toBe(0);
    stopSecond();
    vi.runAllTimers();
    expect(harness.stopped()).toBe(1);
    vi.useRealTimers();
  });
});

describe('noraebang seams (PROTOCOL.md §12)', () => {
  it('applies the echo preset at start and again when the settings change', async () => {
    const { mics, push, rack } = await started(false);
    expect(rack.mixes).toEqual([DEFAULT_ECHO_MIX]);
    push(roster(slot(2, { state: 'connected', micId: MIC_A })));
    expect(rack.monitors.get(2)).toBe(false);

    const hall = { wet: 0.42, feedback: 0.5, lowpassHz: 3000, reverbSend: 0.32 };
    settings.mix = hall;
    settings.monitorAlways = true;
    mics.refreshSettings();
    expect(rack.mixes.at(-1)).toEqual(hall);
    expect(rack.monitors.get(2)).toBe(true);
  });

  it('maps phone-mic device ids to roster slots for the reveal', async () => {
    const { mics, push } = await started();
    push(roster(slot(3, { state: 'connected', micId: MIC_B })));
    expect(mics.slotForMicrophone(`remote:${MIC_B}`)).toBe(3);
    expect(mics.slotForMicrophone(`remote:${MIC_A}`)).toBeNull();
    expect(mics.slotForMicrophone('default')).toBeNull();
  });

  it('sends song-result through the TV socket', async () => {
    const { mics, sent } = await started();
    const frame = {
      type: 'song-result' as const,
      title: 'Song',
      results: [{ slot: 1, displayScore: 91, rawScore: 640, tier: 'excellent' as const, rank: 1 }],
    };
    expect(mics.sendSongResult(frame)).toBe(true);
    expect(sent.at(-1)).toEqual(frame);
  });
});


describe('party frames (PROTOCOL.md §13.6)', () => {
  it("applies each phone's own volume and echo to its slot, and resets a freed slot", async () => {
    const { push, rack } = await started();
    push({ type: 'mix', slot: 2, volumePct: 120, echoPct: 50 });
    expect(rack.slotMixes.has(2)).toBe(false);

    push(roster(slot(2, { state: 'connected', micId: MIC_A })));
    expect(rack.slotMixes.get(2)).toEqual({ volume: 1.2, echo: 0.5 });
    push({ type: 'mix', slot: 2, volumePct: 0, echoPct: 200 });
    expect(rack.slotMixes.get(2)).toEqual({ volume: 0, echo: 2 });

    push({ type: 'slot-lost', slot: 2, micId: MIC_A, reason: 'bye' });
    rack.slotMixes.clear();
    push(roster(slot(2, { state: 'connected', micId: MIC_B })));
    expect(rack.slotMixes.has(2)).toBe(false);
  });

  it('hands party frames and seat changes to the party client, the latest snapshot first', async () => {
    const { mics, push, sent } = await started();
    const party = {
      type: 'party' as const,
      party: {
        rev: 1,
        tvConnected: true,
        stage: { state: 'lobby' as const, singers: [] },
        queue: [],
        queueTotal: 0,
        singers: [],
        scores: [],
      },
    };
    push(party);
    const events: unknown[] = [];
    const unsubscribe = mics.subscribeParty((event) => events.push(event));
    expect(events).toEqual([{ kind: 'frame', frame: party }]);

    push({ type: 'ready', v: 1, iceServers: [] });
    push({ type: 'fx', slot: 1, sound: 'cheer' });
    push({ type: 'control', slot: 1, micId: MIC_A, action: 'pause' });
    push({ type: 'mix', slot: 1, volumePct: 100, echoPct: 100 });
    expect(events.slice(1)).toEqual([
      { kind: 'ready' },
      { kind: 'frame', frame: { type: 'fx', slot: 1, sound: 'cheer' } },
      { kind: 'frame', frame: { type: 'control', slot: 1, micId: MIC_A, action: 'pause' } },
    ]);
    unsubscribe();

    expect(mics.sendParty({ type: 'reset-scores' })).toBe(true);
    expect(sent.at(-1)).toEqual({ type: 'reset-scores' });
  });
});
