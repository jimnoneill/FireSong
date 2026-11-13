import {
  encodeFrame,
  parseServerToMic,
  PING_INTERVAL_SECS,
  type MicToServer,
  type ServerToMic,
} from '@/features/remote-mic/protocol';

import type { OpenSocket, SocketPort, TimerPort } from './ports';
import { BACKOFF_RESET_AFTER_MS, decideOnClose, type CloseDecision } from './reconnect';

/** A client with no `pong` for this long drops the socket and reconnects. */
export const PONG_TIMEOUT_MS = 10_000;
/** Close code the phone uses when it gives up on a silent socket. */
export const CLIENT_TIMEOUT_CLOSE = 4000;
const NORMAL_CLOSE = 1000;

export type HelloFrame = Extract<MicToServer, { type: 'hello' }>;

export type SignalingDeps = {
  url: string;
  openSocket: OpenSocket;
  timers: TimerPort;
  random: () => number;
};

export type SignalingEvents = {
  /** Built at every connect, so a reset identity is used straight away. */
  hello: () => HelloFrame;
  onFrame: (frame: Exclude<ServerToMic, { type: 'pong' }>) => void;
  onOpen: () => void;
  onDown: (decision: CloseDecision) => void;
  /** `bad-resume`: drop the stored identity before the immediate reconnect. */
  onFreshIdentity: () => void;
};

/**
 * The phone's `/rtc` socket: hello on every connect, `ping`/`pong`
 * keepalive and the reconnect policy of PROTOCOL.md §4.1.
 */
export class MicSignaling {
  private socket: SocketPort | null = null;
  private generation = 0;
  private attempt = 0;
  private freshIdentityTried = false;
  private openedAt: number | null = null;
  private lastPongAt = 0;
  private retryTimer: number | null = null;
  private pingTimer: number | null = null;
  private stopped = true;

  private readonly deps: SignalingDeps;
  private readonly events: SignalingEvents;

  constructor(deps: SignalingDeps, events: SignalingEvents) {
    this.deps = deps;
    this.events = events;
  }

  get isOpen(): boolean {
    return this.openedAt !== null;
  }

  start(): void {
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  /** Skips a pending backoff (page shown again, user tap); a live or opening socket is kept. */
  reconnectNow(): void {
    if (this.stopped || this.socket !== null) {
      return;
    }
    this.connect();
  }

  stop(sayBye: boolean): void {
    if (sayBye) {
      this.send({ type: 'bye' });
    }
    this.stopped = true;
    this.retire(NORMAL_CLOSE);
  }

  send(frame: MicToServer): boolean {
    if (this.socket === null || this.openedAt === null) {
      return false;
    }
    this.socket.send(encodeFrame(frame));
    return true;
  }

  private connect(): void {
    this.retire(NORMAL_CLOSE);
    const generation = this.generation;
    const current = (): boolean => generation === this.generation;

    this.socket = this.deps.openSocket(this.deps.url, {
      onOpen: () => {
        if (current()) {
          this.handleOpen();
        }
      },
      onMessage: (data) => {
        if (current()) {
          this.handleMessage(data);
        }
      },
      onClose: (code) => {
        if (current()) {
          this.handleDown(code);
        }
      },
    });
  }

  private handleOpen(): void {
    this.openedAt = this.deps.timers.now();
    this.lastPongAt = this.openedAt;
    this.send(this.events.hello());
    this.pingTimer = this.deps.timers.setInterval(
      () => this.keepAlive(),
      PING_INTERVAL_SECS * 1_000,
    );
    this.events.onOpen();
  }

  private handleMessage(data: string): void {
    const frame = parseServerToMic(data);
    if (frame === null) {
      return;
    }
    if (frame.type === 'pong') {
      this.lastPongAt = this.deps.timers.now();
      return;
    }
    if (frame.type === 'assign') {
      this.freshIdentityTried = false;
    }
    this.events.onFrame(frame);
  }

  private keepAlive(): void {
    const now = this.deps.timers.now();
    if (now - this.lastPongAt > PONG_TIMEOUT_MS) {
      const silent = this.socket;
      this.handleDown(CLIENT_TIMEOUT_CLOSE);
      silent?.close(CLIENT_TIMEOUT_CLOSE);
      return;
    }
    this.send({ type: 'ping', t: now });
  }

  private handleDown(code: number): void {
    const upFor = this.openedAt === null ? 0 : this.deps.timers.now() - this.openedAt;
    if (upFor >= BACKOFF_RESET_AFTER_MS) {
      this.attempt = 0;
    }
    this.retire(null);

    const decision = decideOnClose(code, this.attempt, this.freshIdentityTried, this.deps.random);
    if (this.stopped) {
      return;
    }
    this.schedule(decision);
    this.events.onDown(decision);
  }

  private schedule(decision: CloseDecision): void {
    switch (decision.kind) {
      case 'stop':
        this.stopped = true;
        return;
      case 'retry-fresh-identity':
        this.freshIdentityTried = true;
        this.events.onFreshIdentity();
        this.connect();
        return;
      case 'retry':
        this.attempt += 1;
        this.retryTimer = this.deps.timers.setTimeout(() => {
          this.retryTimer = null;
          this.connect();
        }, decision.delayMs);
        return;
    }
  }

  /** Forgets the current socket; `closeCode` also closes it. */
  private retire(closeCode: number | null): void {
    this.generation += 1;
    if (this.retryTimer !== null) {
      this.deps.timers.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.pingTimer !== null) {
      this.deps.timers.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.socket !== null && closeCode !== null) {
      this.socket.close(closeCode);
    }
    this.socket = null;
    this.openedAt = null;
  }
}
