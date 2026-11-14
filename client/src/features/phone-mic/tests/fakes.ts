/// <reference types="node" />
import { setImmediate as nextTurn } from 'node:timers/promises';

import type { KeyValueStore } from '@/features/phone-mic/lib/identity';
import type {
  AnswerOutcome,
  MediaStartResult,
  MicMediaPort,
  MicPeerPort,
  NetworkPort,
  OpenSocket,
  PagePort,
  PeerLinkState,
  PhoneMicPorts,
  SocketHandlers,
  SocketPort,
  TimerPort,
  WakeLockPort,
  WakeLockState,
} from '@/features/phone-mic/lib/ports';
import type { IceCandidate, ServerToMic, ServerToMicParty } from '@/features/remote-mic/protocol';

/** Lets pending promise chains settle. */
export const settle = async (turns = 5): Promise<void> => {
  if (turns <= 0) {
    return;
  }
  await nextTurn();
  await settle(turns - 1);
};

type Task = { at: number; every: number | null; callback: () => void };

export class FakeClock implements TimerPort {
  private nowMs = 1_000_000;
  private nextId = 1;
  private readonly tasks = new Map<number, Task>();

  readonly now = (): number => this.nowMs;
  readonly setTimeout = (callback: () => void, ms: number): number => this.add(callback, ms, null);
  readonly setInterval = (callback: () => void, ms: number): number => this.add(callback, ms, ms);
  readonly clearTimeout = (handle: number): void => {
    this.tasks.delete(handle);
  };
  readonly clearInterval = (handle: number): void => {
    this.tasks.delete(handle);
  };

  /** Runs every timer due within `ms`, in order. */
  advance(ms: number): void {
    const end = this.nowMs + ms;
    for (let due = this.nextDue(end); due !== null; due = this.nextDue(end)) {
      const [id, task] = due;
      this.nowMs = task.at;
      if (task.every === null) {
        this.tasks.delete(id);
      } else {
        task.at += task.every;
      }
      task.callback();
    }
    this.nowMs = end;
  }

  private nextDue(end: number): [number, Task] | null {
    let found: [number, Task] | null = null;
    for (const entry of this.tasks) {
      if (entry[1].at <= end && (found === null || entry[1].at < found[1].at)) {
        found = entry;
      }
    }
    return found;
  }

  private add(callback: () => void, ms: number, every: number | null): number {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { at: this.nowMs + ms, every, callback });
    return id;
  }
}

export type SentFrame = Record<string, unknown> & { type: string };

const isSentFrame = (value: unknown): value is SentFrame =>
  typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';

export class FakeSocket implements SocketPort {
  readonly sent: SentFrame[] = [];
  closedWith: number | null = null;

  readonly url: string;
  private readonly handlers: SocketHandlers;

  constructor(url: string, handlers: SocketHandlers) {
    this.url = url;
    this.handlers = handlers;
  }

  send(data: string): void {
    const frame: unknown = JSON.parse(data);
    if (!isSentFrame(frame)) {
      throw new TypeError(`not a frame: ${data}`);
    }
    this.sent.push(frame);
  }

  close(code: number): void {
    this.closedWith = code;
  }

  accept(): void {
    this.handlers.onOpen();
  }

  deliver(frame: ServerToMic | ServerToMicParty): void {
    this.handlers.onMessage(JSON.stringify(frame));
  }

  drop(code: number): void {
    this.handlers.onClose(code);
  }

  ofType(type: string): SentFrame[] {
    return this.sent.filter((frame) => frame.type === type);
  }
}

export class FakeSockets {
  readonly opened: FakeSocket[] = [];

  readonly open: OpenSocket = (url, handlers) => {
    const socket = new FakeSocket(url, handlers);
    this.opened.push(socket);
    return socket;
  };

  get last(): FakeSocket {
    const socket = this.opened.at(-1);
    if (socket === undefined) {
      throw new Error('no socket was opened');
    }
    return socket;
  }
}

export class FakeMedia implements MicMediaPort {
  startResult: MediaStartResult = 'ok';
  restartResult: MediaStartResult = 'ok';
  healthy = true;
  meterRunning = true;
  starts = 0;
  restarts = 0;
  stops = 0;
  enabled = true;
  private readonly troubleListeners: (() => void)[] = [];

  readonly start = (): Promise<MediaStartResult> => {
    this.starts += 1;
    return Promise.resolve(this.startResult);
  };
  readonly restart = (): Promise<MediaStartResult> => {
    this.restarts += 1;
    if (this.restartResult === 'ok') {
      this.healthy = true;
    }
    return Promise.resolve(this.restartResult);
  };
  readonly setEnabled = (enabled: boolean): void => {
    this.enabled = enabled;
  };
  readonly isHealthy = (): boolean => this.healthy;
  readonly ensureMeterRunning = (): Promise<boolean> => Promise.resolve(this.meterRunning);
  readonly stop = (): void => {
    this.stops += 1;
  };
  readonly settings = (): Record<string, unknown> => ({ sampleRate: 48_000 });
  readonly onTrouble = (listener: () => void): void => {
    this.troubleListeners.push(listener);
  };

  fireTrouble(): void {
    this.healthy = false;
    this.troubleListeners.forEach((listener) => listener());
  }
}

export class FakePeer implements MicPeerPort {
  opens = 0;
  iceRestarts = 0;
  closes = 0;
  trackSwaps = 0;
  answerOutcome: AnswerOutcome = 'applied';
  readonly answers: string[] = [];
  readonly candidates: (IceCandidate | null)[] = [];
  private readonly stateListeners: ((state: PeerLinkState) => void)[] = [];

  readonly open = (): Promise<string | null> => {
    this.opens += 1;
    return Promise.resolve(`offer-${this.opens}`);
  };
  readonly restartIce = (): Promise<string | null> => {
    this.iceRestarts += 1;
    return Promise.resolve(`restart-${this.iceRestarts}`);
  };
  readonly acceptAnswer = (sdp: string): Promise<AnswerOutcome> => {
    this.answers.push(sdp);
    return Promise.resolve(this.answerOutcome);
  };
  readonly addRemoteCandidate = (candidate: IceCandidate | null): Promise<void> => {
    this.candidates.push(candidate);
    return Promise.resolve();
  };
  readonly replaceTrack = (): Promise<void> => {
    this.trackSwaps += 1;
    return Promise.resolve();
  };
  readonly close = (): void => {
    this.closes += 1;
  };
  readonly diag = (): Promise<Record<string, unknown>> => Promise.resolve({ state: 'connected' });
  readonly onStateChange = (listener: (state: PeerLinkState) => void): void => {
    this.stateListeners.push(listener);
  };

  emit(state: PeerLinkState): void {
    this.stateListeners.forEach((listener) => listener(state));
  }
}

export class FakeWakeLock implements WakeLockPort {
  result: WakeLockState = 'held';
  acquires = 0;
  releases = 0;
  private readonly releasedListeners: (() => void)[] = [];

  readonly acquire = (): Promise<WakeLockState> => {
    this.acquires += 1;
    return Promise.resolve(this.result);
  };
  readonly release = (): void => {
    this.releases += 1;
  };
  readonly onReleased = (listener: () => void): void => {
    this.releasedListeners.push(listener);
  };

  systemRelease(): void {
    this.releasedListeners.forEach((listener) => listener());
  }
}

export class FakePage implements PagePort {
  visible = true;
  private readonly visibleListeners: (() => void)[] = [];
  private readonly showListeners: ((persisted: boolean) => void)[] = [];

  readonly isVisible = (): boolean => this.visible;
  readonly onVisible = (listener: () => void): void => {
    this.visibleListeners.push(listener);
  };
  readonly onPageShow = (listener: (persisted: boolean) => void): void => {
    this.showListeners.push(listener);
  };

  hide(): void {
    this.visible = false;
  }

  show(): void {
    this.visible = true;
    this.visibleListeners.forEach((listener) => listener());
  }

  restoreFromCache(): void {
    this.visible = true;
    this.showListeners.forEach((listener) => listener(true));
  }
}

export class FakeNetwork implements NetworkPort {
  connectionType: string | null = null;
  private readonly changeListeners: (() => void)[] = [];

  readonly type = (): string | null => this.connectionType;
  readonly onChange = (listener: () => void): void => {
    this.changeListeners.push(listener);
  };

  change(type: string | null): void {
    this.connectionType = type;
    this.changeListeners.forEach((listener) => listener());
  }
}

export const memoryStore = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    get: (key) => data.get(key) ?? null,
    set: (key, value) => {
      data.set(key, value);
    },
    remove: (key) => {
      data.delete(key);
    },
  };
};

export type Rig = {
  ports: PhoneMicPorts;
  clock: FakeClock;
  sockets: FakeSockets;
  media: FakeMedia;
  peer: FakePeer;
  wakeLock: FakeWakeLock;
  page: FakePage;
  network: FakeNetwork;
  storage: ReturnType<typeof memoryStore>;
  errors: unknown[];
};

export const createRig = (): Rig => {
  const clock = new FakeClock();
  const sockets = new FakeSockets();
  const media = new FakeMedia();
  const peer = new FakePeer();
  const wakeLock = new FakeWakeLock();
  const page = new FakePage();
  const network = new FakeNetwork();
  const storage = memoryStore();
  const errors: unknown[] = [];
  let micCount = 0;

  return {
    clock,
    sockets,
    media,
    peer,
    wakeLock,
    page,
    network,
    storage,
    errors,
    ports: {
      socketUrl: 'wss://phone.example/rtc',
      openSocket: sockets.open,
      media,
      peer,
      wakeLock,
      page,
      network,
      storage,
      timers: clock,
      random: () => 0.5,
      newMicId: () => {
        micCount += 1;
        return `mic-0000000${micCount}`;
      },
      userAgent: 'test',
      reportError: (error) => errors.push(error),
    },
  };
};

export const RESUME_KEY = '0123456789abcdef0123456789abcdef';
