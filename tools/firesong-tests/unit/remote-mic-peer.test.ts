import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TvMicPeer, type PeerEvents, type PeerStats } from '@/bridge/remote-mic-peer';

const OFFER = [
  'v=0',
  's=-',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=sendonly',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  '',
].join('\r\n');

class FakePc extends EventTarget {
  config: RTCConfiguration;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  iceGatheringState: RTCIceGatheringState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  readonly candidates: (RTCIceCandidateInit | undefined)[] = [];
  stats: Record<string, unknown>[] = [];
  closed = false;

  constructor(config: RTCConfiguration) {
    super();
    this.config = config;
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
  }
  async createAnswer() {
    return { type: 'answer' as const, sdp: OFFER.replace('a=sendonly', 'a=recvonly') };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
    this.iceGatheringState = 'gathering';
  }
  async addIceCandidate(candidate?: RTCIceCandidateInit) {
    this.candidates.push(candidate);
  }
  async getStats() {
    return new Map(this.stats.map((stat, index) => [String(index), stat]));
  }
  close() {
    this.closed = true;
  }
  finishGathering() {
    this.iceGatheringState = 'complete';
    this.dispatchEvent(new Event('icegatheringstatechange'));
  }
  setConnection(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}

const setup = () => {
  let pc: FakePc | null = null;
  const events = {
    onStream: vi.fn(),
    onAnswer: vi.fn(),
    onRestartNeeded: vi.fn(),
    onStats: vi.fn<(stats: PeerStats) => void>(),
    onError: vi.fn(),
  } satisfies PeerEvents;
  const peer = new TvMicPeer({ micId: 'mic-aaaaaaaa', iceServers: [], events }, (config) => {
    pc = new FakePc(config);
    return pc as unknown as RTCPeerConnection;
  });
  if (pc === null) {
    throw new Error('peer connection not created');
  }
  return { peer, pc: pc as FakePc, events };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TvMicPeer', () => {
  it('answers after ICE gathering completes, with the Opus answer munged', async () => {
    const { peer, pc, events } = setup();
    expect(pc.config.bundlePolicy).toBe('max-bundle');
    const done = peer.acceptOffer(OFFER);
    await vi.advanceTimersByTimeAsync(0);
    expect(events.onAnswer).not.toHaveBeenCalled();
    pc.finishGathering();
    await done;
    expect(pc.remoteDescription).toEqual({ type: 'offer', sdp: OFFER });
    const answer = events.onAnswer.mock.calls[0][0] as string;
    expect(answer).toContain('a=recvonly');
    expect(answer).toContain('a=ptime:10');
    expect(answer).toMatch(/a=fmtp:111 .*stereo=0/);
  });

  it('answers anyway after the 2 s gathering limit', async () => {
    const { peer, events } = setup();
    const done = peer.acceptOffer(OFFER);
    await vi.advanceTimersByTimeAsync(1999);
    expect(events.onAnswer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(events.onAnswer).toHaveBeenCalledTimes(1);
  });

  it('queues trickled candidates until the offer is applied', async () => {
    const { peer, pc } = setup();
    peer.addIce({ candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMid: '0' });
    peer.addIce(null);
    expect(pc.candidates).toEqual([]);
    const done = peer.acceptOffer(OFFER);
    await vi.advanceTimersByTimeAsync(0);
    pc.finishGathering();
    await done;
    expect(pc.candidates).toHaveLength(2);
    expect(pc.candidates[1]).toBeUndefined();
  });

  it('sets the minimum jitter buffer on the received track', () => {
    const { pc, events } = setup();
    const receiver = { jitterBufferTarget: null as number | null };
    const stream = { id: 's' };
    const event = Object.assign(new Event('track'), { receiver, streams: [stream], track: {} });
    pc.dispatchEvent(event);
    expect(receiver.jitterBufferTarget).toBe(0);
    expect(events.onStream).toHaveBeenCalledWith(stream);

    const legacy = { playoutDelayHint: 0.5 };
    pc.dispatchEvent(Object.assign(new Event('track'), { receiver: legacy, streams: [stream], track: {} }));
    expect(legacy.playoutDelayHint).toBe(0);
  });

  it('asks for an ICE restart once on failure, and after 3 s disconnected', async () => {
    const { pc, events } = setup();
    pc.setConnection('failed');
    pc.setConnection('failed');
    expect(events.onRestartNeeded).toHaveBeenCalledTimes(1);
    pc.setConnection('connected');
    pc.setConnection('disconnected');
    await vi.advanceTimersByTimeAsync(2999);
    expect(events.onRestartNeeded).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(events.onRestartNeeded).toHaveBeenCalledTimes(2);
    pc.setConnection('connected');
    pc.setConnection('disconnected');
    pc.setConnection('connected');
    await vi.advanceTimersByTimeAsync(5000);
    expect(events.onRestartNeeded).toHaveBeenCalledTimes(2);
  });

  it('reports jitter-buffer delay from getStats every 2 s', async () => {
    const { pc, events, peer } = setup();
    pc.stats = [
      { type: 'outbound-rtp', kind: 'audio' },
      {
        type: 'inbound-rtp',
        kind: 'audio',
        jitterBufferDelay: 960,
        jitterBufferEmittedCount: 48_000,
        jitterBufferTargetDelay: 480,
        packetsReceived: 100,
        packetsLost: 2,
      },
    ];
    await vi.advanceTimersByTimeAsync(2000);
    expect(events.onStats).toHaveBeenLastCalledWith({
      jitterMs: null,
      jitterBufferTargetMs: 10,
      packetsReceived: 100,
      packetsLost: 2,
    });
    pc.stats[1] = { ...pc.stats[1], jitterBufferDelay: 960 + 1440, jitterBufferEmittedCount: 96_000 };
    await vi.advanceTimersByTimeAsync(2000);
    expect(events.onStats.mock.lastCall?.[0].jitterMs).toBeCloseTo(30, 9);

    peer.close();
    expect(pc.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.onStats).toHaveBeenCalledTimes(2);
  });
});
