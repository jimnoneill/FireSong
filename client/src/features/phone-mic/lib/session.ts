import {
  isMicSlot,
  MAX_DIAG_BYTES,
  PROTOCOL_VERSION,
  type IceServer,
  type MicSlot,
  type MuteSource,
  type RtcErrorCode,
  type ServerToMic,
} from '@/features/remote-mic/protocol';

import { describeError } from './errors';
import {
  ensureMicIdentity,
  forgetMicIdentity,
  normalizeSingerName,
  preferredSlot,
  readSingerName,
  writeMicIdentity,
  writeSingerName,
} from './identity';
import type { PeerLinkState, PhoneMicPorts, WakeLockState } from './ports';
import type { CloseDecision, StopReason } from './reconnect';
import { MicSignaling, type HelloFrame } from './signaling';

export type PhoneMicStage = 'idle' | 'starting' | 'joined' | 'ended';

/** How far the voice gets: no socket, socket but no TV, negotiating, or flowing. */
export type PhoneMicLink = 'offline' | 'waiting-tv' | 'connecting' | 'live';

export type PhoneMicProblem = 'mic-denied' | 'mic-unavailable' | 'slots-full' | StopReason;

type SongResultFrame = Extract<ServerToMic, { type: 'song-result' }>;

export type SongResultView = Omit<SongResultFrame, 'type'>;

export type PhoneMicSnapshot = {
  stage: PhoneMicStage;
  slot: MicSlot | null;
  link: PhoneMicLink;
  muted: boolean;
  mutedBy: MuteSource | null;
  /** Recovery needs a user gesture ("Tap to rejoin"). */
  needsTap: boolean;
  problem: PhoneMicProblem | null;
  wakeLock: WakeLockState;
  result: SongResultView | null;
};

type InboundFrame = Exclude<ServerToMic, { type: 'pong' }>;
type SessionFrame = Extract<InboundFrame, { type: 'answer' | 'ice' | 'restart' | 'tv-state' }>;
type StateFrame = Exclude<InboundFrame, SessionFrame>;

const SESSION_FRAME_TYPES: ReadonlySet<InboundFrame['type']> = new Set([
  'answer',
  'ice',
  'restart',
  'tv-state',
]);

const isSessionFrame = (frame: InboundFrame): frame is SessionFrame =>
  SESSION_FRAME_TYPES.has(frame.type);

const DIAG_INTERVAL_MS = 15_000;
/** iOS unmutes a capture track shortly after the page is shown again. */
const VISIBLE_SETTLE_MS = 500;
const ANSWER_RETRY_MS = 1_000;

const INITIAL_SNAPSHOT: PhoneMicSnapshot = {
  stage: 'idle',
  slot: null,
  link: 'offline',
  muted: false,
  mutedBy: null,
  needsTap: false,
  problem: null,
  wakeLock: 'idle',
  result: null,
};

const toResultView = (frame: SongResultFrame): SongResultView => ({
  displayScore: frame.displayScore,
  rawScore: frame.rawScore,
  tier: frame.tier,
  ...(frame.rank === undefined ? {} : { rank: frame.rank }),
  ...(frame.singers === undefined ? {} : { singers: frame.singers }),
  ...(frame.title === undefined ? {} : { title: frame.title }),
});

const byteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * The phone mic: joins a slot over `/rtc`, keeps one send-only peer
 * connection to the TV and recovers capture, ICE and the socket on its own.
 * React reads it through {@link PhoneMicSession.subscribe} and
 * {@link PhoneMicSession.getSnapshot}.
 */
export class PhoneMicSession {
  private snapshot: PhoneMicSnapshot = INITIAL_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private readonly signaling: MicSignaling;
  private iceServers: readonly IceServer[] = [];
  private tvConnected = false;
  private name: string | null;
  private muteDirty = false;
  private recoveries = 0;
  private recoveryPending = false;
  private recovering = false;
  private diagTimer: number | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly ports: PhoneMicPorts,
    private readonly linkSlot: MicSlot | null,
  ) {
    this.name = normalizeSingerName(readSingerName(ports.storage));
    this.signaling = new MicSignaling(
      {
        url: ports.socketUrl,
        openSocket: ports.openSocket,
        timers: ports.timers,
        random: ports.random,
      },
      {
        hello: () => this.hello(),
        onFrame: (frame) => this.handleFrame(frame),
        onOpen: () => this.update({ link: 'offline' }),
        onDown: (decision) => this.handleDown(decision),
        onFreshIdentity: () => forgetMicIdentity(ports.storage),
      },
    );
    ports.peer.onStateChange((state) => this.handlePeerState(state));
    ports.media.onTrouble(() => this.handleMediaTrouble());
    ports.wakeLock.onReleased(() => this.update({ wakeLock: 'idle' }));
    ports.page.onVisible(() => this.handleVisible());
    ports.page.onPageShow((persisted) => {
      if (persisted) {
        this.handleVisible();
      }
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): PhoneMicSnapshot => this.snapshot;

  /** The QR's slot, shown on the join button before any `assign`. */
  get requestedSlot(): MicSlot | null {
    return this.linkSlot;
  }

  get singerName(): string {
    return this.name ?? '';
  }

  /** Call from the Join tap: capture and audio playback need the gesture. */
  join(nameInput: string): void {
    if (this.snapshot.stage === 'starting' || this.snapshot.stage === 'joined') {
      return;
    }
    this.name = normalizeSingerName(nameInput);
    writeSingerName(this.ports.storage, this.name);
    this.detach(this.start());
  }

  rejoin(): void {
    this.join(this.name ?? '');
  }

  /** Call from the "Tap to rejoin" banner. */
  tapToResume(): void {
    if (this.snapshot.stage !== 'joined') {
      return;
    }
    this.update({ needsTap: false });
    this.detach(this.restartMedia());
    this.acquireWakeLock();
    this.signaling.reconnectNow();
  }

  toggleMute(): void {
    if (this.snapshot.stage !== 'joined') {
      return;
    }
    const muted = !this.snapshot.muted;
    this.applyMute(muted, 'mic');
    this.muteDirty = !this.signaling.send({ type: 'mute', muted });
  }

  /** Frees the slot at once (`bye`) and releases the microphone. */
  leave(): void {
    this.signaling.stop(true);
    this.release();
    this.update({ ...INITIAL_SNAPSHOT });
  }

  dismissResult(): void {
    this.update({ result: null });
  }

  private async start(): Promise<void> {
    this.update({ stage: 'starting', problem: null, needsTap: false, result: null });
    const started = await this.ports.media.start();
    if (started !== 'ok') {
      this.update({
        stage: 'idle',
        problem: started === 'denied' ? 'mic-denied' : 'mic-unavailable',
      });
      return;
    }

    this.ports.media.setEnabled(!this.snapshot.muted);
    this.update({ stage: 'joined', link: 'offline' });
    this.acquireWakeLock();
    this.signaling.start();
  }

  private hello(): HelloFrame {
    const identity = ensureMicIdentity(this.ports.storage, this.ports.newMicId);
    const slot = preferredSlot(this.snapshot.slot, this.linkSlot, identity);
    return {
      type: 'hello',
      v: PROTOCOL_VERSION,
      micId: identity.micId,
      ...(identity.resumeKey === undefined ? {} : { resumeKey: identity.resumeKey }),
      ...(slot === undefined ? {} : { slot }),
      ...(this.name === null ? {} : { name: this.name }),
    };
  }

  private handleFrame(frame: InboundFrame): void {
    if (isSessionFrame(frame)) {
      this.handleSessionFrame(frame);
    } else {
      this.handleStateFrame(frame);
    }
  }

  private handleSessionFrame(frame: SessionFrame): void {
    switch (frame.type) {
      case 'answer':
        this.detach(this.handleAnswer(frame.sdp));
        return;
      case 'ice':
        this.detach(this.ports.peer.addRemoteCandidate(frame.candidate));
        return;
      case 'restart':
        this.detach(this.restartPeer());
        return;
      case 'tv-state':
        this.handleTvState(frame.connected);
        return;
    }
  }

  private handleStateFrame(frame: StateFrame): void {
    switch (frame.type) {
      case 'assign':
        this.handleAssign(frame);
        return;
      case 'mute':
        this.applyMute(frame.muted, frame.by);
        return;
      case 'song-result':
        this.update({ result: toResultView(frame) });
        return;
      case 'slot-lost':
        this.ports.peer.close();
        return;
      case 'error':
        this.handleError(frame.code);
        return;
    }
  }

  private handleAssign(frame: Extract<ServerToMic, { type: 'assign' }>): void {
    if (!isMicSlot(frame.slot)) {
      return;
    }
    writeMicIdentity(this.ports.storage, {
      micId: frame.micId,
      resumeKey: frame.resumeKey,
      slot: frame.slot,
    });
    this.iceServers = frame.iceServers;
    this.update({ slot: frame.slot, problem: null });

    if (this.muteDirty || (!frame.reclaimed && this.snapshot.muted)) {
      this.muteDirty = !this.signaling.send({ type: 'mute', muted: this.snapshot.muted });
    }
    this.handleTvState(frame.tvConnected);
  }

  private handleTvState(connected: boolean): void {
    this.tvConnected = connected;
    if (connected) {
      this.detach(this.startPeer());
      return;
    }
    this.ports.peer.close();
    this.stopDiag();
    this.update({ link: 'waiting-tv' });
  }

  private handleError(code: RtcErrorCode): void {
    this.lastError = code;
    if (code === 'slots-full') {
      this.update({ problem: 'slots-full' });
    } else if (code === 'no-tv') {
      this.handleTvState(false);
    }
  }

  private handleDown(decision: CloseDecision): void {
    this.stopDiag();
    if (decision.kind !== 'stop') {
      this.update({ link: 'offline' });
      return;
    }
    this.release();
    this.update({ stage: 'ended', link: 'offline', problem: decision.reason, needsTap: false });
  }

  private async startPeer(): Promise<void> {
    this.update({ link: 'connecting' });
    const sdp = await this.ports.peer.open(this.iceServers);
    if (sdp !== null) {
      this.signaling.send({ type: 'offer', sdp, restart: false });
    }
  }

  private async restartPeer(): Promise<void> {
    if (!this.tvConnected) {
      return;
    }
    const sdp = await this.ports.peer.restartIce();
    if (sdp === null) {
      await this.startPeer();
      return;
    }
    this.signaling.send({ type: 'offer', sdp, restart: true });
  }

  private async handleAnswer(sdp: string): Promise<void> {
    const outcome = await this.ports.peer.acceptAnswer(sdp);
    if (outcome === 'failed') {
      this.ports.timers.setTimeout(() => {
        if (this.tvConnected && this.snapshot.stage === 'joined') {
          this.detach(this.startPeer());
        }
      }, ANSWER_RETRY_MS);
    }
  }

  private handlePeerState(state: PeerLinkState): void {
    switch (state) {
      case 'connected':
        this.update({ link: 'live' });
        this.startDiag();
        return;
      case 'failed':
        this.update({ link: 'connecting' });
        this.detach(this.restartPeer());
        return;
      case 'connecting':
      case 'disconnected':
        this.update({ link: 'connecting' });
        return;
      case 'idle':
        return;
    }
  }

  private applyMute(muted: boolean, by: MuteSource): void {
    this.ports.media.setEnabled(!muted);
    this.update({ muted, mutedBy: muted ? by : null });
  }

  private handleMediaTrouble(): void {
    if (this.snapshot.stage !== 'joined') {
      return;
    }
    if (!this.ports.page.isVisible()) {
      this.recoveryPending = true;
      return;
    }
    this.detach(this.restartMedia());
  }

  private handleVisible(): void {
    if (this.snapshot.stage !== 'joined') {
      return;
    }
    this.acquireWakeLock();
    this.signaling.reconnectNow();
    this.ports.timers.setTimeout(() => this.detach(this.checkMedia()), VISIBLE_SETTLE_MS);
  }

  private async checkMedia(): Promise<void> {
    if (this.snapshot.stage !== 'joined') {
      return;
    }
    if (this.recoveryPending || !this.ports.media.isHealthy()) {
      await this.restartMedia();
      return;
    }
    const meterRunning = await this.ports.media.ensureMeterRunning();
    this.update({ needsTap: !meterRunning });
  }

  /** New capture track into the existing sender: no renegotiation. */
  private async restartMedia(): Promise<void> {
    if (this.recovering) {
      return;
    }
    this.recovering = true;
    try {
      const restarted = await this.ports.media.restart();
      if (restarted !== 'ok') {
        this.update({ needsTap: true });
        return;
      }
      this.recoveryPending = false;
      this.recoveries += 1;
      this.ports.media.setEnabled(!this.snapshot.muted);
      await this.ports.peer.replaceTrack();
      const meterRunning = await this.ports.media.ensureMeterRunning();
      this.update({ needsTap: !meterRunning });
      this.detach(this.sendDiag('recovered'));
    } finally {
      this.recovering = false;
    }
  }

  private acquireWakeLock(): void {
    this.detach(
      (async () => {
        const state = await this.ports.wakeLock.acquire();
        this.update({ wakeLock: state });
      })(),
    );
  }

  private startDiag(): void {
    this.detach(this.sendDiag('connected'));
    if (this.diagTimer === null) {
      this.diagTimer = this.ports.timers.setInterval(
        () => this.detach(this.sendDiag('periodic')),
        DIAG_INTERVAL_MS,
      );
    }
  }

  private stopDiag(): void {
    if (this.diagTimer !== null) {
      this.ports.timers.clearInterval(this.diagTimer);
      this.diagTimer = null;
    }
  }

  private async sendDiag(reason: string): Promise<void> {
    const data: Record<string, unknown> = {
      reason,
      media: this.ports.media.settings(),
      peer: await this.ports.peer.diag(),
      wakeLock: this.snapshot.wakeLock,
      visible: this.ports.page.isVisible(),
      recoveries: this.recoveries,
      lastError: this.lastError,
      ua: this.ports.userAgent,
    };
    const fitted = byteLength(data) <= MAX_DIAG_BYTES ? data : { reason, oversized: true };
    this.signaling.send({ type: 'diag', data: fitted });
  }

  private release(): void {
    this.stopDiag();
    this.tvConnected = false;
    this.recoveryPending = false;
    this.ports.peer.close();
    this.ports.media.stop();
    this.ports.wakeLock.release();
  }

  private detach(task: Promise<unknown>): void {
    void task.catch((error: unknown) => {
      this.lastError = describeError(error);
      this.ports.reportError(error);
    });
  }

  private update(patch: Partial<PhoneMicSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}
