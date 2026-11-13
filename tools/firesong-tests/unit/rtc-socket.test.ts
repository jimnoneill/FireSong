import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRtcSocket,
  defaultShouldReconnect,
  reconnectDelayMs,
  rtcSocketUrl,
  type RtcTransportFactory,
  type RtcTransportHandlers,
} from '@/bridge/rtc-socket';

type Frame = { type: string; t?: number };

class FakeServer {
  readonly connections: { url: string; handlers: RtcTransportHandlers; sent: Frame[]; closed: number | null }[] =
    [];

  readonly transport: RtcTransportFactory = (url, handlers) => {
    const connection = { url, handlers, sent: [] as Frame[], closed: null as number | null };
    this.connections.push(connection);
    return {
      send: (data) => connection.sent.push(JSON.parse(data) as Frame),
      close: (code) => {
        connection.closed = code;
      },
    };
  };

  get last() {
    const connection = this.connections.at(-1);
    if (connection === undefined) {
      throw new Error('no connection');
    }
    return connection;
  }
}

const open = (server: FakeServer, onFrame = vi.fn(), shouldReconnect?: (code: number) => boolean) =>
  createRtcSocket<Frame, Frame>({
    url: () => 'ws://tv.test/rtc',
    hello: () => ({ type: 'hello' }),
    ping: (t) => ({ type: 'ping', t }),
    parse: (raw) => {
      try {
        return JSON.parse(raw) as Frame;
      } catch {
        return null;
      }
    },
    isPong: (frame) => frame.type === 'pong',
    onFrame,
    shouldReconnect,
    transport: server.transport,
    random: () => 0.5,
  });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reconnect policy', () => {
  it('backs off 0.5, 1, 2, 4, then 8 s with ±20 % jitter', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((attempt) => reconnectDelayMs(attempt, () => 0.5))).toEqual([
      500, 1000, 2000, 4000, 8000, 8000, 8000,
    ]);
    expect(reconnectDelayMs(0, () => 0)).toBe(400);
    expect(reconnectDelayMs(4, () => 1)).toBe(9600);
  });

  it('does not reconnect after replaced, kicked or bad-request closes', () => {
    expect(defaultShouldReconnect(4409)).toBe(false);
    expect(defaultShouldReconnect(4410)).toBe(false);
    expect(defaultShouldReconnect(4400)).toBe(false);
    expect(defaultShouldReconnect(1006)).toBe(true);
    expect(defaultShouldReconnect(4503)).toBe(true);
  });

  it('builds the socket URL from the page origin only', () => {
    expect(rtcSocketUrl('https://tv.example:64443/playback?tv=1#x')).toBe(
      'wss://tv.example:64443/rtc',
    );
    expect(rtcSocketUrl('http://localhost:64448/')).toBe('ws://localhost:64448/rtc');
  });
});

describe('createRtcSocket', () => {
  it('sends hello on open and delivers parsed text frames', () => {
    const server = new FakeServer();
    const onFrame = vi.fn();
    const socket = open(server, onFrame);
    expect(socket.status().state).toBe('connecting');
    expect(socket.send({ type: 'early' })).toBe(false);

    server.last.handlers.onOpen();
    expect(server.last.sent).toEqual([{ type: 'hello' }]);
    server.last.handlers.onMessage('{"type":"roster"}');
    server.last.handlers.onMessage('not json');
    server.last.handlers.onMessage(new ArrayBuffer(4));
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledWith({ type: 'roster' });
    expect(socket.send({ type: 'answer' })).toBe(true);
  });

  it('pings every 5 s and reconnects after 10 s without a pong', () => {
    const server = new FakeServer();
    open(server);
    server.last.handlers.onOpen();
    vi.advanceTimersByTime(5000);
    expect(server.last.sent.map((frame) => frame.type)).toEqual(['hello', 'ping']);
    server.last.handlers.onMessage(JSON.stringify({ type: 'pong', t: 1 }));
    vi.advanceTimersByTime(10_000);
    expect(server.connections).toHaveLength(1);
    vi.advanceTimersByTime(5000);
    expect(server.connections[0].closed).toBe(1000);
    vi.advanceTimersByTime(500);
    expect(server.connections).toHaveLength(2);
  });

  it('ignores events from a transport it already dropped', () => {
    const server = new FakeServer();
    const onFrame = vi.fn();
    const socket = open(server, onFrame);
    const first = server.last;
    first.handlers.onOpen();
    first.handlers.onClose(1006);
    vi.advanceTimersByTime(500);
    first.handlers.onMessage('{"type":"stale"}');
    first.handlers.onClose(1006);
    expect(onFrame).not.toHaveBeenCalled();
    expect(server.connections).toHaveLength(2);
    expect(socket.status().attempt).toBe(1);
  });

  it('escalates the backoff and resets it after 30 s connected', () => {
    const server = new FakeServer();
    const socket = open(server);
    server.last.handlers.onClose(1006);
    vi.advanceTimersByTime(499);
    expect(server.connections).toHaveLength(1);
    vi.advanceTimersByTime(1);
    server.last.handlers.onClose(1006);
    vi.advanceTimersByTime(1000);
    expect(server.connections).toHaveLength(3);
    server.last.handlers.onOpen();
    for (let i = 0; i < 7; i += 1) {
      vi.advanceTimersByTime(5000);
      server.last.handlers.onMessage('{"type":"pong"}');
    }
    server.last.handlers.onClose(1006);
    expect(socket.status()).toMatchObject({ state: 'waiting', attempt: 1, closeCode: 1006 });
    vi.advanceTimersByTime(500);
    expect(server.connections).toHaveLength(4);
  });

  it('stops for good after a no-reconnect close or stop()', () => {
    const server = new FakeServer();
    const socket = open(server);
    server.last.handlers.onOpen();
    server.last.handlers.onClose(4409);
    vi.advanceTimersByTime(60_000);
    expect(server.connections).toHaveLength(1);
    expect(socket.status().state).toBe('stopped');

    const other = new FakeServer();
    const stopped = open(other);
    other.last.handlers.onOpen();
    stopped.stop();
    expect(other.last.closed).toBe(1000);
    other.last.handlers.onClose(1000);
    vi.advanceTimersByTime(60_000);
    expect(other.connections).toHaveLength(1);
    expect(stopped.send({ type: 'late' })).toBe(false);
  });

  it('lets the caller decide which closes reconnect', () => {
    const server = new FakeServer();
    open(server, vi.fn(), (code) => code === 4503);
    server.last.handlers.onClose(4503);
    vi.advanceTimersByTime(500);
    expect(server.connections).toHaveLength(2);
    server.last.handlers.onClose(1006);
    vi.advanceTimersByTime(60_000);
    expect(server.connections).toHaveLength(2);
  });
});
