import {
  CLOSE_CODE,
  NO_RECONNECT_CLOSE_CODES,
  PING_INTERVAL_SECS,
  RTC_PATH,
} from '@/features/remote-mic/protocol';

/**
 * Client side of the `/rtc` signaling socket (PROTOCOL.md §4): sends `hello`
 * on every connect, keeps the link alive with `ping`/`pong`, and reconnects
 * with backoff. Roles (TV, phone) differ only in their frames and in which
 * close codes end the session.
 */

const PONG_TIMEOUT_MS = 10_000;
const BACKOFF_RESET_MS = 30_000;
const BACKOFF_STEPS_MS = [500, 1000, 2000, 4000, 8000];
const JITTER = 0.2;
const NORMAL_CLOSE = 1000;

export type RtcTransport = { send(data: string): void; close(code: number): void };

export type RtcTransportHandlers = {
  onOpen(): void;
  onMessage(data: unknown): void;
  onClose(code: number): void;
};

export type RtcTransportFactory = (url: string, handlers: RtcTransportHandlers) => RtcTransport;

export type RtcSocketState = 'connecting' | 'open' | 'waiting' | 'stopped';

export type RtcSocketStatus = { state: RtcSocketState; attempt: number; closeCode: number | null };

export type RtcSocketOptions<In, Out> = {
  url: () => string;
  hello: () => Out;
  ping: (t: number) => Out;
  parse: (raw: string) => In | null;
  isPong: (frame: In) => boolean;
  onFrame: (frame: In) => void;
  onStatus?: (status: RtcSocketStatus) => void;
  /** Whether to reconnect after the server closed with this code. */
  shouldReconnect?: (closeCode: number) => boolean;
  transport?: RtcTransportFactory;
  random?: () => number;
};

export type RtcSocket<Out> = {
  send(frame: Out): boolean;
  stop(): void;
  status(): RtcSocketStatus;
};

/** 0.5, 1, 2, 4, then 8 s, each with ±20 % jitter. */
export const reconnectDelayMs = (attempt: number, random: () => number = Math.random): number => {
  const base = BACKOFF_STEPS_MS[Math.min(Math.max(attempt, 0), BACKOFF_STEPS_MS.length - 1)];
  return Math.round(base * (1 - JITTER + 2 * JITTER * random()));
};

export const defaultShouldReconnect = (closeCode: number): boolean =>
  closeCode !== CLOSE_CODE.badRequest && !NO_RECONNECT_CLOSE_CODES.includes(closeCode);

/** `ws(s)://<this origin>/rtc`, never carrying the page's query or hash. */
export const rtcSocketUrl = (pageUrl: string): string => {
  const url = new URL(RTC_PATH, pageUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

export const browserTransport: RtcTransportFactory = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.addEventListener('open', () => handlers.onOpen());
  socket.addEventListener('message', (event: MessageEvent<unknown>) =>
    handlers.onMessage(event.data),
  );
  socket.addEventListener('close', (event) => handlers.onClose(event.code));
  return {
    send: (data) => socket.send(data),
    close: (code) => socket.close(code),
  };
};

class Connection<In, Out> implements RtcSocket<Out> {
  private transport: RtcTransport | null = null;
  private generation = 0;
  private state: RtcSocketState = 'connecting';
  private attempt = 0;
  private closeCode: number | null = null;
  private openedAt = 0;
  private lastPongAt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: RtcSocketOptions<In, Out>) {
    this.connect();
  }

  send(frame: Out): boolean {
    if (this.state !== 'open' || this.transport === null) {
      return false;
    }
    this.transport.send(JSON.stringify(frame));
    return true;
  }

  stop(): void {
    this.generation += 1;
    this.clearTimers();
    this.transport?.close(NORMAL_CLOSE);
    this.transport = null;
    this.setState('stopped');
  }

  status(): RtcSocketStatus {
    return { state: this.state, attempt: this.attempt, closeCode: this.closeCode };
  }

  private connect(): void {
    this.generation += 1;
    const generation = this.generation;
    const live = () => generation === this.generation;
    const factory = this.options.transport ?? browserTransport;
    this.setState('connecting');
    this.transport = factory(this.options.url(), {
      onOpen: () => {
        if (live()) {
          this.onOpen();
        }
      },
      onMessage: (data) => {
        if (live()) {
          this.onMessage(data);
        }
      },
      onClose: (code) => {
        if (live()) {
          this.onClose(code);
        }
      },
    });
  }

  private onOpen(): void {
    this.openedAt = Date.now();
    this.lastPongAt = this.openedAt;
    this.setState('open');
    this.send(this.options.hello());
    this.pingTimer = setInterval(() => this.tick(), PING_INTERVAL_SECS * 1000);
  }

  private onMessage(data: unknown): void {
    const frame = typeof data === 'string' ? this.options.parse(data) : null;
    if (frame === null) {
      return;
    }
    if (this.options.isPong(frame)) {
      this.lastPongAt = Date.now();
    }
    this.options.onFrame(frame);
  }

  private onClose(code: number): void {
    this.closeCode = code;
    const reconnect = (this.options.shouldReconnect ?? defaultShouldReconnect)(code);
    this.dropTransport();
    if (reconnect) {
      this.scheduleReconnect();
    } else {
      this.setState('stopped');
    }
  }

  private tick(): void {
    const now = Date.now();
    if (now - this.lastPongAt > PONG_TIMEOUT_MS) {
      this.transport?.close(NORMAL_CLOSE);
      this.dropTransport();
      this.scheduleReconnect();
      return;
    }
    this.send(this.options.ping(now));
  }

  private dropTransport(): void {
    if (this.openedAt !== 0 && Date.now() - this.openedAt >= BACKOFF_RESET_MS) {
      this.attempt = 0;
    }
    this.openedAt = 0;
    this.generation += 1;
    this.transport = null;
    this.clearTimers();
  }

  private scheduleReconnect(): void {
    const delay = reconnectDelayMs(this.attempt, this.options.random);
    this.attempt += 1;
    this.setState('waiting');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private setState(state: RtcSocketState): void {
    this.state = state;
    this.options.onStatus?.(this.status());
  }
}

export const createRtcSocket = <In, Out>(options: RtcSocketOptions<In, Out>): RtcSocket<Out> =>
  new Connection(options);
