import type { IceCandidate, IceServer } from '@/features/remote-mic/protocol';

import { describeError } from './errors';
import { mungeOpusSdp, sdpPtimeMs, type OpusPtimeMs } from './opus-sdp';
import type { AnswerOutcome, MicPeerPort, PeerLinkState, TimerPort } from './ports';

/** Non-trickle offers wait this long for ICE gathering (PROTOCOL.md §7). */
export const GATHER_TIMEOUT_MS = 2_000;

/** Munge levels tried in order: 10 ms Opus frames, 20 ms, then the browser's own SDP. */
const PTIME_LEVELS: readonly (OpusPtimeMs | null)[] = [10, 20, null];

type SenderLike<Track> = {
  replaceTrack: (track: Track | null) => Promise<void>;
};

type StatsLike = {
  forEach: (callback: (stat: unknown) => void) => void;
};

/** The part of `RTCPeerConnection` the phone uses; tests provide a fake. */
export type PeerConnectionLike<Track> = {
  readonly connectionState: RTCPeerConnectionState;
  readonly iceGatheringState: RTCIceGatheringState;
  readonly signalingState: RTCSignalingState;
  readonly localDescription: { readonly sdp: string } | null;
  addTransceiver(
    track: Track,
    init: { direction: 'sendonly' },
  ): { readonly sender: SenderLike<Track> };
  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate?: RTCIceCandidateInit): Promise<void>;
  getStats(): Promise<StatsLike>;
  close(): void;
  addEventListener(
    type: 'connectionstatechange' | 'icegatheringstatechange',
    listener: () => void,
  ): void;
  removeEventListener(
    type: 'connectionstatechange' | 'icegatheringstatechange',
    listener: () => void,
  ): void;
};

export type PeerLinkDeps<Track> = {
  createPeer: (config: RTCConfiguration) => PeerConnectionLike<Track>;
  currentTrack: () => Track | null;
  timers: TimerPort;
};

type RtpSample = { packetsSent: number; bytesSent: number; at: number };

const LINK_STATES = {
  new: 'connecting',
  connecting: 'connecting',
  connected: 'connected',
  disconnected: 'disconnected',
  failed: 'failed',
  closed: 'idle',
} satisfies Record<RTCPeerConnectionState, PeerLinkState>;

type MungeLevel = OpusPtimeMs | null;

/** Applies the most-munged SDP the browser accepts; rethrows the last refusal. */
const applyMunged = async (
  sdp: string,
  apply: (variant: string) => Promise<void>,
  levels: readonly MungeLevel[] = PTIME_LEVELS,
): Promise<MungeLevel> => {
  const [level = null, ...rest] = levels;
  try {
    await apply(level === null ? sdp : mungeOpusSdp(sdp, level));
    return level;
  } catch (error) {
    if (rest.length === 0) {
      throw error;
    }
    return applyMunged(sdp, apply, rest);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const numberField = (record: Record<string, unknown>, key: string): number | null => {
  const value = record[key];
  return typeof value === 'number' ? value : null;
};

const findOutboundAudio = (stats: StatsLike): Record<string, unknown> | null => {
  let found: Record<string, unknown> | null = null;
  stats.forEach((stat) => {
    if (isRecord(stat) && stat.type === 'outbound-rtp' && stat.kind === 'audio') {
      found = stat;
    }
  });
  return found;
};

/**
 * The phone's single send-only `RTCPeerConnection`: munged non-trickle
 * offers, answers with a ptime fallback, ICE restarts and track swaps.
 */
export class PeerLink<Track> implements MicPeerPort {
  private pc: PeerConnectionLike<Track> | null = null;
  private sender: SenderLike<Track> | null = null;
  private generation = 0;
  private detachListeners: (() => void) | null = null;
  private readonly stateListeners: ((state: PeerLinkState) => void)[] = [];
  private answerPtime: OpusPtimeMs | 'browser' | null = null;
  private iceErrors = 0;
  private answerError: string | null = null;
  private lastRtp: RtpSample | null = null;

  private readonly deps: PeerLinkDeps<Track>;

  constructor(deps: PeerLinkDeps<Track>) {
    this.deps = deps;
  }

  onStateChange(listener: (state: PeerLinkState) => void): void {
    this.stateListeners.push(listener);
  }

  async open(iceServers: readonly IceServer[]): Promise<string | null> {
    this.close();
    const track = this.deps.currentTrack();
    if (track === null) {
      return null;
    }

    const pc = this.deps.createPeer({ iceServers: iceServers.map((server) => ({ ...server })) });
    this.pc = pc;
    this.listen(pc, this.generation);
    this.sender = pc.addTransceiver(track, { direction: 'sendonly' }).sender;
    return this.offer(pc, this.generation, false);
  }

  async restartIce(): Promise<string | null> {
    const pc = this.pc;
    if (pc === null || pc.connectionState === 'closed') {
      return null;
    }
    return this.offer(pc, this.generation, true);
  }

  async acceptAnswer(sdp: string): Promise<AnswerOutcome> {
    const pc = this.pc;
    if (pc?.signalingState !== 'have-local-offer') {
      return 'ignored';
    }

    try {
      const level = await applyMunged(sdp, (variant) =>
        pc.setRemoteDescription({ type: 'answer', sdp: variant }),
      );
      this.answerPtime = level ?? 'browser';
      return 'applied';
    } catch (error) {
      this.answerError = describeError(error);
      return 'failed';
    }
  }

  async addRemoteCandidate(candidate: IceCandidate | null): Promise<void> {
    const pc = this.pc;
    if (pc === null) {
      return;
    }
    try {
      await pc.addIceCandidate(candidate === null ? undefined : { ...candidate });
    } catch {
      this.iceErrors += 1;
    }
  }

  async replaceTrack(): Promise<void> {
    await this.sender?.replaceTrack(this.deps.currentTrack());
  }

  close(): void {
    this.generation += 1;
    this.detachListeners?.();
    this.detachListeners = null;
    this.pc?.close();
    this.pc = null;
    this.sender = null;
    this.answerPtime = null;
    this.lastRtp = null;
  }

  async diag(): Promise<Record<string, unknown>> {
    const pc = this.pc;
    if (pc === null) {
      return { state: 'idle' };
    }
    const outbound = findOutboundAudio(await pc.getStats());
    return {
      state: pc.connectionState,
      answerPtime: this.answerPtime,
      localPtime: sdpPtimeMs(pc.localDescription?.sdp ?? ''),
      iceErrors: this.iceErrors,
      answerError: this.answerError,
      ...(outbound === null ? {} : this.rtpDiag(outbound)),
    };
  }

  private rtpDiag(outbound: Record<string, unknown>): Record<string, unknown> {
    const sample: RtpSample = {
      packetsSent: numberField(outbound, 'packetsSent') ?? 0,
      bytesSent: numberField(outbound, 'bytesSent') ?? 0,
      at: this.deps.timers.now(),
    };
    const previous = this.lastRtp;
    this.lastRtp = sample;
    const packets = previous === null ? 0 : sample.packetsSent - previous.packetsSent;
    const elapsedMs = previous === null ? 0 : sample.at - previous.at;
    return {
      packetsSent: sample.packetsSent,
      bytesSent: sample.bytesSent,
      targetBitrate: numberField(outbound, 'targetBitrate'),
      msPerPacket: packets > 0 ? Math.round((elapsedMs / packets) * 10) / 10 : null,
    };
  }

  private async offer(
    pc: PeerConnectionLike<Track>,
    generation: number,
    iceRestart: boolean,
  ): Promise<string | null> {
    const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    if (generation !== this.generation) {
      return null;
    }
    await applyMunged(offer.sdp ?? '', (variant) =>
      pc.setLocalDescription({ type: 'offer', sdp: variant }),
    );
    await this.gathered(pc);
    return generation === this.generation ? (pc.localDescription?.sdp ?? null) : null;
  }

  private gathered(pc: PeerConnectionLike<Track>): Promise<void> {
    if (pc.iceGatheringState === 'complete') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = (): void => {
        pc.removeEventListener('icegatheringstatechange', onChange);
        this.deps.timers.clearTimeout(timer);
        resolve();
      };
      const onChange = (): void => {
        if (pc.iceGatheringState === 'complete') {
          done();
        }
      };
      const timer = this.deps.timers.setTimeout(done, GATHER_TIMEOUT_MS);
      pc.addEventListener('icegatheringstatechange', onChange);
    });
  }

  private listen(pc: PeerConnectionLike<Track>, generation: number): void {
    const onChange = (): void => {
      if (generation === this.generation) {
        const state = LINK_STATES[pc.connectionState];
        this.stateListeners.forEach((listener) => listener(state));
      }
    };
    pc.addEventListener('connectionstatechange', onChange);
    this.detachListeners = () => pc.removeEventListener('connectionstatechange', onChange);
  }
}
