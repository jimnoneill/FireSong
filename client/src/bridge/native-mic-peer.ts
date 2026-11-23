import { jitterBufferDelayMs, type JitterCounters } from '@/audio/slot-latency';
import { mungeOpusSdp } from '@/features/remote-mic/opus-sdp';
import {
  isValidMicId,
  type IceCandidate,
  type IceServer,
  type MicSlot,
} from '@/features/remote-mic/protocol';

import type { AppMessage, NativeMicLinkPort, PageMessage } from './native-mic-protocol';
import type { PeerEvents, PeerInit, PeerPort } from './remote-mic-peer';

const ANSWER_TIMEOUT_MS = 6000;
const PEER_ID_MAX = 2 ** 31 - 1;

/** The app closes the whole door on a field outside these limits, so nothing outside them is sent. */
const FRAME_MAX_BYTES = 65_536;
const SDP_MAX_CHARS = 32_768;
const SDP_PREFIX = 'v=0';
const ICE_SERVERS_MAX = 8;
const ICE_URLS_MAX = 8;
const ICE_URL_MAX_CHARS = 512;
const ICE_URL_SCHEMES = ['stun:', 'turn:', 'turns:'];
const ICE_LOGIN_MAX_CHARS = 256;
const CANDIDATE_MAX_CHARS = 1024;
const MLINE_INDEX_MAX = 65_535;

type PeerMessage = Extract<AppMessage, { peer: number }>;
type OfferMessage = Extract<PageMessage, { t: 'offer' }>;

/** One offer waiting for its `answer` or `peer-error`. */
type Pending = {
  seq: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * `idle`: no offer sent yet under the current peer id; `live`: the app holds
 * this peer id; `closed`: the peer is done and sends nothing more.
 */
type PeerState = 'idle' | 'live' | 'closed';

let lastPeerId = 0;

/** Ids are unique per page load, so a reused connection never sees one twice. */
const nextPeerId = (): number => {
  lastPeerId = lastPeerId >= PEER_ID_MAX ? 1 : lastPeerId + 1;
  return lastPeerId;
};

const isNativeIceUrl = (url: string): boolean =>
  url.length <= ICE_URL_MAX_CHARS && ICE_URL_SCHEMES.some((scheme) => url.startsWith(scheme));

const withinLogin = (value: string | undefined): boolean =>
  value === undefined || value.length <= ICE_LOGIN_MAX_CHARS;

/** The ICE servers the app accepts: STUN/TURN URLs and logins within its limits. */
const nativeIceServers = (servers: readonly IceServer[]): IceServer[] =>
  servers
    .map((server) => ({
      ...server,
      urls: server.urls.filter(isNativeIceUrl).slice(0, ICE_URLS_MAX),
    }))
    .filter(
      (server) =>
        server.urls.length > 0 && withinLogin(server.username) && withinLogin(server.credential),
    )
    .slice(0, ICE_SERVERS_MAX);

const encoder = new TextEncoder();

/** JSON escaping can grow a valid SDP past the door's frame limit, so the frame itself is measured. */
const isNativeOffer = (offer: OfferMessage): boolean =>
  isValidMicId(offer.micId) &&
  offer.sdp.length <= SDP_MAX_CHARS &&
  offer.sdp.startsWith(SDP_PREFIX) &&
  encoder.encode(JSON.stringify(offer)).byteLength <= FRAME_MAX_BYTES;

const withinCandidate = (value: string | null | undefined): boolean =>
  value === null || value === undefined || value.length <= CANDIDATE_MAX_CHARS;

const isNativeCandidate = ({
  candidate,
  sdpMid,
  sdpMLineIndex,
  usernameFragment,
}: IceCandidate): boolean =>
  candidate.length <= CANDIDATE_MAX_CHARS &&
  withinCandidate(sdpMid) &&
  withinCandidate(usernameFragment) &&
  (sdpMLineIndex === null ||
    sdpMLineIndex === undefined ||
    (Number.isInteger(sdpMLineIndex) && sdpMLineIndex >= 0 && sdpMLineIndex <= MLINE_INDEX_MAX));

/** Mean jitter-buffer target since the stream started, as `TvMicPeer` reports it. */
const meanTargetMs = (stats: Extract<AppMessage, { t: 'peer-stats' }>): number | null =>
  stats.jitterBufferEmittedCount > 0
    ? (stats.jitterBufferTargetDelay / stats.jitterBufferEmittedCount) * 1000
    : null;

/**
 * The TV end of one phone's connection when the app's voice engine receives
 * it: offers, candidates and closes become mics-protocol messages for one
 * page-chosen peer id. A peer whose answer fails or times out closes that id
 * and, unless a restart cannot help, asks the phone for a restart; the next
 * offer then opens a fresh connection in the app under a new id.
 */
export class NativeMicPeer implements PeerPort {
  readonly micId: string;
  private readonly slot: MicSlot;
  private readonly iceServers: readonly IceServer[];
  private readonly events: PeerEvents;
  private readonly unsubscribes: (() => void)[] = [];
  private peer = nextPeerId();
  private seq = 0;
  private state: PeerState = 'idle';
  private pending: Pending | null = null;
  private counters: JitterCounters | null = null;

  constructor(
    private readonly link: NativeMicLinkPort,
    { micId, slot, iceServers, events }: PeerInit,
  ) {
    this.micId = micId;
    this.slot = slot;
    this.iceServers = nativeIceServers(iceServers);
    this.events = events;
    this.unsubscribes.push(
      link.subscribe((message) => this.onMessage(message)),
      link.onLost(() => this.finish()),
    );
  }

  /** A newer offer from the phone ends the waiting one quietly: its answer would be stale. */
  acceptOffer(sdp: string): Promise<void> {
    if (this.state === 'closed') {
      return Promise.resolve();
    }
    this.settle();
    const seq = this.seq + 1;
    const offer: OfferMessage = {
      t: 'offer',
      peer: this.peer,
      seq,
      slot: this.slot,
      micId: this.micId,
      sdp,
      iceServers: this.iceServers,
    };
    if (!isNativeOffer(offer)) {
      return Promise.reject(new Error('native mic offer outside the voice door limits'));
    }
    if (!this.link.send(offer)) {
      return Promise.reject(new Error('native mic link refused the offer'));
    }
    this.seq = seq;
    this.state = 'live';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.seq === seq) {
          this.fail(new Error('native mic answer timed out'), true);
        }
      }, ANSWER_TIMEOUT_MS);
      this.pending = { seq, resolve, reject, timer };
    });
  }

  addIce(candidate: IceCandidate | null): void {
    if (this.state !== 'live' || (candidate !== null && !isNativeCandidate(candidate))) {
      return;
    }
    this.link.send({ t: 'ice', peer: this.peer, candidate });
  }

  close(): void {
    if (this.state === 'live') {
      this.link.send({ t: 'close', peer: this.peer });
    }
    this.finish();
  }

  private onMessage(message: AppMessage): void {
    if (this.state !== 'live' || !('peer' in message) || message.peer !== this.peer) {
      return;
    }
    this.onPeerMessage(message);
  }

  private onPeerMessage(message: PeerMessage): void {
    switch (message.t) {
      case 'answer':
        if (message.seq === this.pending?.seq) {
          this.settle();
          this.events.onAnswer(mungeOpusSdp(message.sdp));
        }
        return;
      case 'peer-error':
        this.onPeerError(message);
        return;
      case 'restart-needed':
        this.events.onRestartNeeded();
        return;
      case 'peer-stats':
        this.onStats(message);
    }
  }

  /**
   * `superseded`: a newer offer for this peer is being answered, so this one
   * ends quietly. `sdp` on a connection's first offer: the app refused the
   * phone's offer itself, and the restart offer would be refused the same way.
   */
  private onPeerError(error: Extract<AppMessage, { t: 'peer-error' }>): void {
    if (error.seq !== this.pending?.seq) {
      return;
    }
    if (error.code === 'superseded') {
      this.settle();
      return;
    }
    const restart = error.code !== 'sdp' || error.seq > 1;
    this.fail(new Error(`native mic peer ${error.code}: ${error.detail}`), restart);
  }

  private onStats(stats: Extract<AppMessage, { t: 'peer-stats' }>): void {
    const counters: JitterCounters = {
      jitterBufferDelay: stats.jitterBufferDelay,
      jitterBufferEmittedCount: stats.jitterBufferEmittedCount,
    };
    this.events.onStats({
      jitterMs: this.counters === null ? null : jitterBufferDelayMs(this.counters, counters),
      jitterBufferTargetMs: meanTargetMs(stats),
      packetsReceived: stats.packetsReceived,
      packetsLost: stats.packetsLost,
    });
    this.counters = counters;
  }

  /**
   * Closes the app's connection for this id, so the next offer opens a fresh
   * one, and asks the phone for that offer when `restart`. A link that takes
   * no `close` is closed or stalled and could not carry a restart either, so
   * the waiting offer then ends quietly.
   */
  private fail(error: Error, restart: boolean): void {
    const pending = this.take();
    const closed = this.link.send({ t: 'close', peer: this.peer });
    this.peer = nextPeerId();
    this.seq = 0;
    this.state = 'idle';
    this.counters = null;
    if (!closed) {
      pending?.resolve();
      return;
    }
    if (restart) {
      this.events.onRestartNeeded();
    }
    pending?.reject(error);
  }

  /** Ends the waiting offer, if any, without an answer or an error. */
  private settle(): void {
    this.take()?.resolve();
  }

  private take(): Pending | null {
    const pending = this.pending;
    this.pending = null;
    if (pending !== null) {
      clearTimeout(pending.timer);
    }
    return pending;
  }

  private finish(): void {
    if (this.state === 'closed') {
      return;
    }
    this.state = 'closed';
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe();
    }
    this.settle();
  }
}
