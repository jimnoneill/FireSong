import { flight } from './flight';
import {
  appMessageSchema,
  NATIVE_FEATURES,
  parseTapMessage,
  type AppMessage,
  type EngineStats,
  type NativeMicLinkPort,
  type PageMessage,
  type ReadyOk,
  type TapBlock,
} from './native-mic-protocol';
import type { NativeVoiceEndpoint } from './native-voice';

/**
 * The page's end of the app's door: `hello`, then `ready`, then JSON messages
 * both ways and binary tap messages from the app. After `ready` the link is
 * lost when the socket ends, the app sends `fatal`, nothing arrives for 5 s,
 * or the engine's audio output stays shut for 20 s.
 */

const NORMAL_CLOSE = 1000;
/** The door closes the socket on a page frame above this size. */
const MAX_FRAME_BYTES = 65_536;
/** Page messages the socket may hold unsent before `send` refuses more. */
const MAX_BUFFERED_BYTES = 1_048_576;
const WATCH_MS = 1000;
/** `status` arrives at 4 Hz, so this much quiet means the app stopped. */
const SILENCE_MS = 5000;
const NO_AUDIO_MS = 20_000;
const ARRIVAL_BIN_MS = 0.5;
const ARRIVAL_BINS = 2000;
const ARRIVAL_QUANTILE = 0.99;
/** Distinct problems one link reports to the flight recorder. */
const MAX_REPORTS = 16;
const MAX_REPORTED_TYPE = 32;

const HELLO: PageMessage = { t: 'hello', v: 2, features: NATIVE_FEATURES };

const encoder = new TextEncoder();

type Phase = 'connecting' | 'ready' | 'lost' | 'closed';

type TapArrival = { p99Ms: number; maxMs: number; count: number };

type Settle = {
  resolve(port: NativeMicLinkPort): void;
  reject(error: Error): void;
};

type Decoded = { ok: true; message: AppMessage } | { ok: false; t: string | null };

/** UTF-8 takes at most 3 bytes per UTF-16 unit, so most frames need no encoding. */
const fitsFrame = (text: string): boolean =>
  text.length * 3 <= MAX_FRAME_BYTES || encoder.encode(text).byteLength <= MAX_FRAME_BYTES;

const typeOf = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const t: unknown = Reflect.get(value, 't');
  return typeof t === 'string' ? t.slice(0, MAX_REPORTED_TYPE) : null;
};

const decodeText = (text: string): Decoded => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, t: null };
  }
  const result = appMessageSchema.safeParse(value);
  return result.success ? { ok: true, message: result.data } : { ok: false, t: typeOf(value) };
};

/** A failing listener is reported and does not keep the others from running. */
const notify = <T>(listener: (value: T) => void, value: T): void => {
  try {
    listener(value);
  } catch (error) {
    reportError(error);
  }
};

/** Intervals between tap messages in 0.5 ms bins; the last bin holds everything longer. */
class ArrivalHistogram {
  private readonly bins = new Uint32Array(ARRIVAL_BINS + 1);
  private count = 0;
  private maxMs = 0;
  private last: number | null = null;

  arrive(now: number): void {
    if (this.last !== null) {
      const intervalMs = now - this.last;
      this.bins[Math.min(Math.floor(intervalMs / ARRIVAL_BIN_MS), ARRIVAL_BINS)] += 1;
      this.count += 1;
      this.maxMs = Math.max(this.maxMs, intervalMs);
    }
    this.last = now;
  }

  /** The p99 is its bin's upper edge, at most `maxMs`; counting restarts. */
  take(): TapArrival | null {
    if (this.count === 0) {
      return null;
    }
    const target = Math.ceil(this.count * ARRIVAL_QUANTILE);
    let seen = 0;
    let bin = 0;
    while (bin < ARRIVAL_BINS && seen + this.bins[bin] < target) {
      seen += this.bins[bin];
      bin += 1;
    }
    const arrival = {
      p99Ms: Math.min((bin + 1) * ARRIVAL_BIN_MS, this.maxMs),
      maxMs: this.maxMs,
      count: this.count,
    };
    this.bins.fill(0);
    this.count = 0;
    this.maxMs = 0;
    return arrival;
  }
}

/** Records the first occurrence of each problem only. */
class FlightReports {
  private readonly seen = new Set<string>();

  once(why: string, t: string | null): void {
    const key = `${why} ${t ?? ''}`;
    if (this.seen.has(key) || this.seen.size >= MAX_REPORTS) {
      return;
    }
    this.seen.add(key);
    flight('native-mics', { why, t });
  }
}

class DoorLink {
  private phase: Phase = 'connecting';
  private readonly events = new AbortController();
  private readonly messageListeners = new Set<(message: AppMessage) => void>();
  private readonly tapListeners = new Set<(block: TapBlock) => void>();
  private readonly lostListeners = new Set<(why: string) => void>();
  private readonly arrivals = new ArrivalHistogram();
  private readonly reports = new FlightReports();
  private deadline: number | null = null;
  private watch: number | null = null;
  private rechecking = false;
  private lostWhy: string | null = null;
  private engineStats: EngineStats | null = null;
  private lastMessageAt = 0;
  private audioDownSince: number | null = null;

  constructor(
    private readonly socket: WebSocket,
    private readonly settle: Settle,
  ) {}

  start(timeoutMs: number): void {
    const { signal } = this.events;
    this.socket.binaryType = 'arraybuffer';
    this.socket.addEventListener('open', () => this.write(HELLO), { signal });
    this.socket.addEventListener(
      'message',
      (event: MessageEvent<unknown>) => this.receive(event.data),
      { signal },
    );
    this.socket.addEventListener('error', () => this.end('error'), { signal });
    this.socket.addEventListener('close', (event) => this.end(`closed ${event.code}`), {
      signal,
    });
    this.deadline = window.setTimeout(() => this.fail('timeout'), timeoutMs);
  }

  private isReady(): boolean {
    return this.phase === 'ready';
  }

  private send(message: PageMessage): boolean {
    return this.isReady() && this.write(message);
  }

  private write(message: PageMessage): boolean {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    const text = JSON.stringify(message);
    if (!fitsFrame(text)) {
      this.reports.once('too-large', message.t);
      return false;
    }
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.reports.once('backpressure', message.t);
      return false;
    }
    this.socket.send(text);
    return true;
  }

  private receive(data: unknown): void {
    const now = performance.now();
    this.lastMessageAt = now;
    if (typeof data === 'string') {
      this.receiveText(data);
    } else if (data instanceof ArrayBuffer) {
      this.receiveTap(data, now);
    }
  }

  private receiveText(text: string): void {
    const decoded = decodeText(text);
    if (!decoded.ok) {
      this.reports.once('bad-message', decoded.t);
    } else if (this.isReady()) {
      this.deliver(decoded.message);
    } else {
      this.handshake(decoded.message);
    }
  }

  private receiveTap(data: ArrayBuffer, now: number): void {
    if (!this.isReady()) {
      return;
    }
    const blocks = parseTapMessage(data);
    if (blocks === null) {
      this.reports.once('bad-tap', null);
      return;
    }
    this.arrivals.arrive(now);
    for (const block of blocks) {
      this.dispatch(this.tapListeners, block);
    }
  }

  private handshake(message: AppMessage): void {
    if (message.t === 'fatal') {
      this.fail(`fatal ${message.reason}`);
      return;
    }
    if (message.t !== 'ready') {
      return;
    }
    if (!message.ok) {
      this.fail(`refused ${message.reason}`);
      return;
    }
    const { features } = message;
    if (!NATIVE_FEATURES.every((feature) => features.includes(feature))) {
      this.fail('no-mics');
      return;
    }
    this.open(message);
  }

  private open(ready: ReadyOk): void {
    this.phase = 'ready';
    this.clearDeadline();
    const now = performance.now();
    this.lastMessageAt = now;
    this.audioDownSince = ready.audio === 'open' ? null : now;
    this.watch = window.setInterval(() => this.check(), WATCH_MS);
    this.settle.resolve(this.port(ready));
  }

  private deliver(message: AppMessage): void {
    if (message.t === 'engine-stats') {
      this.engineStats = message;
      this.audioDownSince = message.open ? null : (this.audioDownSince ?? performance.now());
    }
    this.dispatch(this.messageListeners, message);
    if (message.t === 'fatal') {
      this.lose(`fatal ${message.reason}`);
    }
  }

  private dispatch<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
    for (const listener of listeners) {
      if (!this.isReady()) {
        return;
      }
      notify(listener, value);
    }
  }

  /** A long main-thread task can delay queued messages, so a finding is re-checked after one yield. */
  private check(): void {
    if (this.rechecking || this.trouble() === null) {
      return;
    }
    this.rechecking = true;
    window.setTimeout(() => {
      this.rechecking = false;
      const why = this.trouble();
      if (why !== null) {
        this.lose(why);
      }
    }, 0);
  }

  private trouble(): string | null {
    const now = performance.now();
    if (now - this.lastMessageAt >= SILENCE_MS) {
      return 'silent';
    }
    if (this.audioDownSince !== null && now - this.audioDownSince >= NO_AUDIO_MS) {
      return 'no-audio';
    }
    return null;
  }

  private end(why: string): void {
    if (this.isReady()) {
      this.lose(why);
    } else {
      this.fail(why);
    }
  }

  private fail(why: string): void {
    if (this.phase !== 'connecting') {
      return;
    }
    this.phase = 'closed';
    this.teardown();
    this.settle.reject(new Error(`native mic link ${why}`));
  }

  private lose(why: string): void {
    if (!this.isReady()) {
      return;
    }
    const listeners = [...this.lostListeners];
    this.phase = 'lost';
    this.lostWhy = why;
    this.teardown();
    for (const listener of listeners) {
      notify(listener, why);
    }
  }

  private close(): void {
    if (!this.isReady()) {
      return;
    }
    this.phase = 'closed';
    this.teardown();
  }

  private teardown(): void {
    this.events.abort();
    this.clearDeadline();
    if (this.watch !== null) {
      window.clearInterval(this.watch);
      this.watch = null;
    }
    this.messageListeners.clear();
    this.tapListeners.clear();
    this.lostListeners.clear();
    this.socket.close(NORMAL_CLOSE);
  }

  private clearDeadline(): void {
    if (this.deadline !== null) {
      window.clearTimeout(this.deadline);
      this.deadline = null;
    }
  }

  private listen<T>(listeners: Set<T>, listener: T): () => void {
    if (this.isReady()) {
      listeners.add(listener);
    }
    return () => {
      listeners.delete(listener);
    };
  }

  /** A listener added after the loss still hears why, once. */
  private listenLost(listener: (why: string) => void): () => void {
    const why = this.lostWhy;
    if (why === null) {
      return this.listen(this.lostListeners, listener);
    }
    let wanted = true;
    queueMicrotask(() => {
      if (wanted) {
        notify(listener, why);
      }
    });
    return () => {
      wanted = false;
    };
  }

  private port(ready: ReadyOk): NativeMicLinkPort {
    return {
      ready,
      send: (message) => this.send(message),
      subscribe: (listener) => this.listen(this.messageListeners, listener),
      onTap: (listener) => this.listen(this.tapListeners, listener),
      onLost: (listener) => this.listenLost(listener),
      latestEngineStats: () => this.engineStats,
      tapArrival: () => this.arrivals.take(),
      close: () => this.close(),
    };
  }
}

/**
 * Opens the mics protocol on the app's door: `hello`, then `ready` within
 * `timeoutMs`. Rejects when the app does not answer with a usable `ready`.
 */
export const connectNativeMicLink = (
  endpoint: NativeVoiceEndpoint,
  timeoutMs = 3000,
): Promise<NativeMicLinkPort> =>
  new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(endpoint.url);
    } catch (error) {
      reject(new Error('native mic link cannot open', { cause: error }));
      return;
    }
    new DoorLink(socket, { resolve, reject }).start(timeoutMs);
  });
