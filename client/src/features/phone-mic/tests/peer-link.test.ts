/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GATHER_TIMEOUT_MS,
  PeerLink,
  type PeerConnectionLike,
} from '@/features/phone-mic/lib/peer-link';
import type { PeerLinkState } from '@/features/phone-mic/lib/ports';
import { FakeClock, settle } from '@/features/phone-mic/tests/fakes';
import { CHROME_OFFER } from '@/features/phone-mic/tests/fixtures';

type Track = { id: string };
type Listener = () => void;

class FakePeerConnection implements PeerConnectionLike<Track> {
  connectionState: RTCPeerConnectionState = 'new';
  iceGatheringState: RTCIceGatheringState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: { sdp: string } | null = null;
  closed = false;
  readonly offerOptions: (RTCOfferOptions | undefined)[] = [];
  readonly remote: string[] = [];
  readonly candidates: (RTCIceCandidateInit | undefined)[] = [];
  readonly sent: (Track | null)[] = [];
  readonly transceivers: { track: Track; direction: string }[] = [];
  /** Remote SDPs containing one of these strings are refused. */
  refuseRemote: string[] = [];
  packetsSent = 0;
  private readonly listeners = new Map<string, Set<Listener>>();

  readonly config: RTCConfiguration;

  constructor(config: RTCConfiguration) {
    this.config = config;
  }

  addTransceiver(track: Track, init: { direction: 'sendonly' }) {
    this.transceivers.push({ track, direction: init.direction });
    return {
      sender: {
        replaceTrack: (next: Track | null) => {
          this.sent.push(next);
          return Promise.resolve();
        },
      },
    };
  }

  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this.offerOptions.push(options);
    return Promise.resolve({ type: 'offer', sdp: CHROME_OFFER });
  }

  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = { sdp: description.sdp ?? '' };
    this.signalingState = 'have-local-offer';
    return Promise.resolve();
  }

  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    const sdp = description.sdp ?? '';
    if (this.refuseRemote.some((needle) => sdp.includes(needle))) {
      return Promise.reject(new Error('refused'));
    }
    this.remote.push(sdp);
    this.signalingState = 'stable';
    return Promise.resolve();
  }

  addIceCandidate(candidate?: RTCIceCandidateInit): Promise<void> {
    this.candidates.push(candidate);
    return Promise.resolve();
  }

  getStats() {
    const report = new Map<string, unknown>([
      ['out', { type: 'outbound-rtp', kind: 'audio', packetsSent: this.packetsSent, bytesSent: 1 }],
    ]);
    return Promise.resolve(report);
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  fire(type: string): void {
    this.listeners.get(type)?.forEach((listener) => listener());
  }

  finishGathering(): void {
    this.iceGatheringState = 'complete';
    this.fire('icegatheringstatechange');
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.fire('connectionstatechange');
  }
}

const rig = () => {
  const clock = new FakeClock();
  const peers: FakePeerConnection[] = [];
  let track: Track | null = { id: 'track-1' };
  const states: PeerLinkState[] = [];
  const link = new PeerLink<Track>({
    createPeer: (config) => {
      const pc = new FakePeerConnection(config);
      peers.push(pc);
      return pc;
    },
    currentTrack: () => track,
    timers: clock,
  });
  link.onStateChange((state) => states.push(state));
  const lastPeer = (): FakePeerConnection => {
    const pc = peers.at(-1);
    if (pc === undefined) {
      throw new Error('no peer connection');
    }
    return pc;
  };
  return {
    clock,
    peers,
    link,
    states,
    lastPeer,
    setTrack: (next: Track | null) => {
      track = next;
    },
  };
};

void test('open sends one track and returns the munged offer once gathering completes', async () => {
  const { link, lastPeer } = rig();
  const result: { offer?: string | null } = {};
  void link.open([{ urls: ['stun:example.invalid'] }]).then((sdp) => {
    result.offer = sdp;
    return sdp;
  });
  await settle();
  assert.equal('offer' in result, false);

  lastPeer().finishGathering();
  await settle();

  assert.deepEqual(lastPeer().transceivers, [{ track: { id: 'track-1' }, direction: 'sendonly' }]);
  assert.deepEqual(lastPeer().config.iceServers, [{ urls: ['stun:example.invalid'] }]);
  assert.match(result.offer ?? '', /a=ptime:10/);
  assert.match(result.offer ?? '', /maxaveragebitrate=64000/);
});

void test('a slow gather still sends the offer after the timeout', async () => {
  const { link, clock } = rig();
  const pending = link.open([]);
  await settle();
  clock.advance(GATHER_TIMEOUT_MS);

  assert.match((await pending) ?? '', /a=ptime:10/);
});

void test('a newer session supersedes an offer still in flight', async () => {
  const { link, peers } = rig();
  const first = link.open([]);
  const second = link.open([]);
  await settle();
  peers.forEach((pc) => pc.finishGathering());

  assert.equal(await first, null);
  assert.match((await second) ?? '', /m=audio/);
  assert.equal(peers[0]?.closed, true);
});

void test('the answer is munged to 10 ms, falling back to 20 ms, then unmunged', async () => {
  const { link, lastPeer, clock } = rig();
  const pending = link.open([]);
  await settle();
  clock.advance(GATHER_TIMEOUT_MS);
  await pending;

  lastPeer().refuseRemote = ['a=ptime:10'];
  assert.equal(await link.acceptAnswer(CHROME_OFFER), 'applied');
  assert.match(lastPeer().remote.at(-1) ?? '', /a=ptime:20/);
  assert.deepEqual((await link.diag()).answerPtime, 20);
});

void test('an answer nobody accepts fails, and one without an offer is ignored', async () => {
  const { link, lastPeer, clock } = rig();
  assert.equal(await link.acceptAnswer('x'), 'ignored');

  const pending = link.open([]);
  await settle();
  clock.advance(GATHER_TIMEOUT_MS);
  await pending;
  lastPeer().refuseRemote = ['v=0'];

  assert.equal(await link.acceptAnswer(CHROME_OFFER), 'failed');
});

void test('restartIce asks for an ICE-restart offer on the same connection', async () => {
  const { link, lastPeer, peers, clock } = rig();
  const opened = link.open([]);
  await settle();
  clock.advance(GATHER_TIMEOUT_MS);
  await opened;

  const restarted = link.restartIce();
  await settle();
  clock.advance(GATHER_TIMEOUT_MS);

  assert.match((await restarted) ?? '', /a=ptime:10/);
  assert.equal(peers.length, 1);
  assert.deepEqual(lastPeer().offerOptions, [undefined, { iceRestart: true }]);
});

void test('replaceTrack hands the current track to the existing sender', async () => {
  const { link, lastPeer, setTrack } = rig();
  void link.open([]);
  await settle();

  setTrack({ id: 'track-2' });
  await link.replaceTrack();

  assert.deepEqual(lastPeer().sent, [{ id: 'track-2' }]);
});

void test('state changes are reported until the connection is replaced', async () => {
  const { link, lastPeer, states, peers } = rig();
  void link.open([]);
  await settle();
  lastPeer().setConnectionState('connected');
  lastPeer().setConnectionState('failed');

  link.close();
  peers[0]?.setConnectionState('closed');

  assert.deepEqual(states, ['connected', 'failed']);
});

void test('diag estimates the packet interval from outbound RTP stats', async () => {
  const { link, lastPeer, clock } = rig();
  void link.open([]);
  await settle();

  lastPeer().packetsSent = 100;
  await link.diag();
  clock.advance(2_000);
  lastPeer().packetsSent = 300;

  assert.equal((await link.diag()).msPerPacket, 10);
});

void test('without a capture track there is nothing to offer', async () => {
  const { link, setTrack, peers } = rig();
  setTrack(null);

  assert.equal(await link.open([]), null);
  assert.equal(peers.length, 0);
});
