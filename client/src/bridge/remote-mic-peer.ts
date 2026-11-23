import { jitterBufferDelayMs, type JitterCounters } from '@/audio/slot-latency';
import { mungeOpusSdp } from '@/features/remote-mic/opus-sdp';
import type { IceCandidate, IceServer, MicSlot } from '@/features/remote-mic/protocol';

/**
 * The TV end of one phone's `RTCPeerConnection` (PROTOCOL.md §7): receive
 * only, answers non-trickle after ICE gathering, asks for an ICE restart when
 * the link fails, and samples jitter-buffer delay for the slot's latency.
 */

const GATHER_TIMEOUT_MS = 2000;
const DISCONNECTED_RESTART_MS = 3000;
const STATS_INTERVAL_MS = 2000;

export type PeerStats = {
  /**
   * Mean jitter-buffer delay since the previous reading; `null` on the first
   * one, whose cumulative average still holds the start-up buffering.
   */
  jitterMs: number | null;
  jitterBufferTargetMs: number | null;
  packetsReceived: number;
  packetsLost: number;
};

export type PeerEvents = {
  onStream(stream: MediaStream): void;
  onAnswer(sdp: string): void;
  onRestartNeeded(): void;
  onStats(stats: PeerStats): void;
  onError(error: unknown): void;
  /** An offer went out on a new connection, whose jitter buffer starts afresh. */
  onNewConnection?(): void;
};

export type PeerInit = {
  micId: string;
  slot: MicSlot;
  iceServers: readonly IceServer[];
  events: PeerEvents;
};

export type PeerPort = {
  readonly micId: string;
  acceptOffer(sdp: string): Promise<void>;
  addIce(candidate: IceCandidate | null): void;
  close(): void;
};

export type PeerConnectionFactory = (config: RTCConfiguration) => RTCPeerConnection;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const numberField = (record: Record<string, unknown>, key: string): number | null => {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const inboundAudio = (report: RTCStatsReport): Record<string, unknown> | null => {
  for (const entry of report.values()) {
    const value: unknown = entry;
    if (isRecord(value) && value.type === 'inbound-rtp' && value.kind === 'audio') {
      return value;
    }
  }
  return null;
};

/** Mean jitter-buffer target since the stream started, from the cumulative `inbound-rtp` counters. */
export const meanTargetMs = (target: number | null, emitted: number | null): number | null =>
  target === null || emitted === null || emitted <= 0 ? null : (target / emitted) * 1000;

const gatheringComplete = (pc: RTCPeerConnection, timeoutMs: number): Promise<void> =>
  new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        done();
      }
    };
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
  });

/** Lowest playout delay the receiver supports; older Chromium names it differently. */
const minimiseJitterBuffer = (receiver: RTCRtpReceiver): void => {
  if (Reflect.has(receiver, 'jitterBufferTarget')) {
    receiver.jitterBufferTarget = 0;
  } else if (Reflect.has(receiver, 'playoutDelayHint')) {
    Reflect.set(receiver, 'playoutDelayHint', 0);
  }
};

export class TvMicPeer implements PeerPort {
  readonly micId: string;
  private readonly pc: RTCPeerConnection;
  private readonly events: PeerEvents;
  private pendingIce: (IceCandidate | null)[] = [];
  private counters: JitterCounters | null = null;
  private restartAsked = false;
  private closed = false;
  private disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly statsTimer: ReturnType<typeof setInterval>;

  constructor(
    { micId, iceServers, events }: PeerInit,
    createPeerConnection: PeerConnectionFactory = (config) => new RTCPeerConnection(config),
  ) {
    this.micId = micId;
    this.events = events;
    this.pc = createPeerConnection({
      iceServers: iceServers.map((server) => ({ ...server })),
      bundlePolicy: 'max-bundle',
    });
    this.pc.addEventListener('track', (event) => {
      minimiseJitterBuffer(event.receiver);
      events.onStream(event.streams.at(0) ?? new MediaStream([event.track]));
    });
    this.pc.addEventListener('connectionstatechange', () => this.onConnectionState());
    this.statsTimer = setInterval(() => {
      this.sampleStats().catch((error: unknown) => events.onError(error));
    }, STATS_INTERVAL_MS);
  }

  async acceptOffer(sdp: string): Promise<void> {
    this.restartAsked = false;
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.flushIce();
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await gatheringComplete(this.pc, GATHER_TIMEOUT_MS);
    const answer = this.pc.localDescription?.sdp;
    if (!this.closed && answer !== undefined) {
      this.events.onAnswer(mungeOpusSdp(answer));
    }
  }

  addIce(candidate: IceCandidate | null): void {
    if (this.pc.remoteDescription === null) {
      this.pendingIce.push(candidate);
      return;
    }
    this.pc
      .addIceCandidate(candidate ?? undefined)
      .catch((error: unknown) => this.events.onError(error));
  }

  close(): void {
    this.closed = true;
    clearInterval(this.statsTimer);
    this.clearDisconnectedTimer();
    this.pc.close();
  }

  private async flushIce(): Promise<void> {
    const pending = this.pendingIce;
    this.pendingIce = [];
    await Promise.all(pending.map((candidate) => this.pc.addIceCandidate(candidate ?? undefined)));
  }

  private onConnectionState(): void {
    const state = this.pc.connectionState;
    if (state === 'connected') {
      this.restartAsked = false;
      this.clearDisconnectedTimer();
    } else if (state === 'failed') {
      this.askRestart();
    } else if (state === 'disconnected' && this.disconnectedTimer === null) {
      this.disconnectedTimer = setTimeout(() => {
        this.disconnectedTimer = null;
        if (this.pc.connectionState === 'disconnected') {
          this.askRestart();
        }
      }, DISCONNECTED_RESTART_MS);
    }
  }

  private askRestart(): void {
    if (this.closed || this.restartAsked) {
      return;
    }
    this.restartAsked = true;
    this.events.onRestartNeeded();
  }

  private clearDisconnectedTimer(): void {
    if (this.disconnectedTimer !== null) {
      clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = null;
    }
  }

  private async sampleStats(): Promise<void> {
    if (this.closed) {
      return;
    }
    const inbound = inboundAudio(await this.pc.getStats());
    if (inbound === null) {
      return;
    }
    const counters: JitterCounters = {
      jitterBufferDelay: numberField(inbound, 'jitterBufferDelay') ?? 0,
      jitterBufferEmittedCount: numberField(inbound, 'jitterBufferEmittedCount') ?? 0,
    };
    this.events.onStats({
      jitterMs: this.counters === null ? null : jitterBufferDelayMs(this.counters, counters),
      jitterBufferTargetMs: meanTargetMs(
        numberField(inbound, 'jitterBufferTargetDelay'),
        numberField(inbound, 'jitterBufferEmittedCount'),
      ),
      packetsReceived: numberField(inbound, 'packetsReceived') ?? 0,
      packetsLost: numberField(inbound, 'packetsLost') ?? 0,
    });
    this.counters = counters;
  }
}
