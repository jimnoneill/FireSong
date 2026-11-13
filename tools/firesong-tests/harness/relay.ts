// Minimal in-test /rtc relay: just enough of docs/firesong/PROTOCOL.md (§4-6)
// for the headless harness. Like the real server it has two listeners, and
// the listener fixes the role: the "tv" port serves the TV page, the "mic"
// port serves the fake phone. It also serves static files.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer } from 'ws';

type Json = Record<string, unknown>;

type Entry = {
  slot: number;
  micId: string;
  resumeKey: string;
  name?: string;
  state: 'connected' | 'reserved';
  socket: WebSocket | null;
  muted: boolean;
  latencyMs?: number;
};

export type StaticFile = { file: string; type: string };

export type Relay = {
  tvOrigin: string;
  micOrigin: string;
  /** Every frame seen, as `<role>> <type>` or `<role>< <type>`. */
  log: string[];
  /** SDP of every TV `answer`, in order. */
  answers: string[];
  setLatency(slot: number, latencyMs: number): void;
  /** Drops a phone's socket without `bye`, like a Wi-Fi blip. */
  dropMic(slot: number): void;
  close(): Promise<void>;
};

const COLORS = ['rose', 'fuchsia', 'amber', 'emerald'];

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

export const startRelay = async (files: {
  tv: Record<string, StaticFile>;
  mic: Record<string, StaticFile>;
}): Promise<Relay> => {
  const slots = new Map<number, Entry>();
  const log: string[] = [];
  const answers: string[] = [];
  let tv: WebSocket | null = null;

  const sendTo = (socket: WebSocket | null, role: string, frame: Json) => {
    if (socket?.readyState === WebSocket.OPEN) {
      log.push(`${role}< ${String(frame.type)}`);
      socket.send(JSON.stringify(frame));
    }
  };

  const roster = () => {
    const list = [1, 2, 3, 4].map((slot) => {
      const entry = slots.get(slot);
      const base = { slot, color: COLORS[slot - 1], muted: entry?.muted ?? false };
      if (entry === undefined) {
        return { ...base, state: 'empty' };
      }
      return {
        ...base,
        state: entry.state,
        micId: entry.micId,
        ...(entry.name === undefined ? {} : { name: entry.name }),
        ...(entry.latencyMs === undefined ? {} : { latencyMs: entry.latencyMs, latencyMethod: 'beep' }),
        ...(entry.state === 'reserved' ? { reservedForSecs: 600 } : {}),
      };
    });
    sendTo(tv, 'tv', { type: 'roster', slots: list });
  };

  const tvLost = (entry: Entry, reason: string) =>
    sendTo(tv, 'tv', { type: 'slot-lost', slot: entry.slot, micId: entry.micId, reason });

  const micHello = (socket: WebSocket, frame: Json): Entry | null => {
    const micId = String(frame.micId);
    const existing = [...slots.values()].find((entry) => entry.micId === micId);
    if (existing !== undefined) {
      if (frame.resumeKey !== existing.resumeKey) {
        sendTo(socket, 'mic', { type: 'error', code: 'bad-resume' });
        socket.close(4403);
        return null;
      }
      existing.socket = socket;
      existing.state = 'connected';
      return existing;
    }
    const wanted = Number(frame.slot);
    const free = [1, 2, 3, 4].filter((slot) => !slots.has(slot));
    const slot = free.includes(wanted) ? wanted : free[0];
    if (slot === undefined) {
      sendTo(socket, 'mic', { type: 'error', code: 'slots-full' });
      socket.close(4503);
      return null;
    }
    const entry: Entry = {
      slot,
      micId,
      resumeKey: randomBytes(16).toString('hex'),
      name: typeof frame.name === 'string' ? frame.name : undefined,
      state: 'connected',
      socket,
      muted: false,
    };
    slots.set(slot, entry);
    return entry;
  };

  const onMic = (socket: WebSocket) => {
    let entry: Entry | null = null;
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Json;
      log.push(`mic> ${String(frame.type)}`);
      if (frame.type === 'ping') {
        sendTo(socket, 'mic', { type: 'pong', t: frame.t });
        return;
      }
      if (frame.type === 'hello') {
        entry = micHello(socket, frame);
        if (entry !== null) {
          sendTo(socket, 'mic', {
            type: 'assign',
            v: 1,
            slot: entry.slot,
            color: COLORS[entry.slot - 1],
            micId: entry.micId,
            resumeKey: entry.resumeKey,
            reclaimed: false,
            tvConnected: tv !== null,
            iceServers: [],
          });
          roster();
        }
        return;
      }
      if (entry === null) {
        return;
      }
      const stamp = { slot: entry.slot, micId: entry.micId };
      if (frame.type === 'offer') {
        if (tv === null) {
          sendTo(socket, 'mic', { type: 'error', code: 'no-tv' });
        } else {
          sendTo(tv, 'tv', { type: 'offer', ...stamp, sdp: frame.sdp, restart: frame.restart });
        }
      } else if (frame.type === 'ice') {
        sendTo(tv, 'tv', { type: 'ice', ...stamp, candidate: frame.candidate });
      } else if (frame.type === 'bye') {
        slots.delete(entry.slot);
        tvLost(entry, 'bye');
        roster();
        entry = null;
      }
    });
    socket.on('close', () => {
      if (entry !== null && entry.socket === socket) {
        entry.socket = null;
        entry.state = 'reserved';
        tvLost(entry, 'disconnected');
        roster();
      }
    });
  };

  const forTv = (frame: Json): Entry | undefined => slots.get(Number(frame.slot));

  const onTv = (socket: WebSocket) => {
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Json;
      log.push(`tv> ${String(frame.type)}`);
      const entry = forTv(frame);
      switch (frame.type) {
        case 'hello':
          if (tv !== null && tv !== socket) {
            sendTo(tv, 'tv', { type: 'error', code: 'tv-replaced' });
            tv.close(4409);
          }
          tv = socket;
          sendTo(socket, 'tv', { type: 'ready', v: 1, iceServers: [] });
          roster();
          for (const phone of slots.values()) {
            sendTo(phone.socket, 'mic', { type: 'tv-state', connected: true });
          }
          break;
        case 'answer':
          answers.push(String(frame.sdp));
          sendTo(entry?.socket ?? null, 'mic', { type: 'answer', sdp: frame.sdp });
          break;
        case 'ice':
          sendTo(entry?.socket ?? null, 'mic', { type: 'ice', candidate: frame.candidate });
          break;
        case 'restart':
          sendTo(entry?.socket ?? null, 'mic', { type: 'restart' });
          break;
        case 'latency':
          if (entry !== undefined) {
            entry.latencyMs = Number(frame.latencyMs);
            roster();
          }
          break;
        case 'ping':
          sendTo(socket, 'tv', { type: 'pong', t: frame.t });
          break;
        default:
          break;
      }
    });
    socket.on('close', () => {
      if (tv === socket) {
        tv = null;
        for (const phone of slots.values()) {
          sendTo(phone.socket, 'mic', { type: 'tv-state', connected: false });
        }
      }
    });
  };

  const makeServer = (role: 'tv' | 'mic') => {
    const statics = files[role];
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://relay').pathname;
      const file = statics[path];
      if (file === undefined) {
        response.writeHead(404).end();
        return;
      }
      readFile(file.file)
        .then((body) => response.writeHead(200, { 'content-type': file.type }).end(body))
        .catch(() => response.writeHead(500).end());
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(request.url ?? '/', 'http://relay').pathname !== '/rtc') {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => (role === 'tv' ? onTv(ws) : onMic(ws)));
    });
    return { server, wss };
  };

  const tvServer = makeServer('tv');
  const micServer = makeServer('mic');
  const [tvOrigin, micOrigin] = await Promise.all([
    listen(tvServer.server),
    listen(micServer.server),
  ]);

  return {
    tvOrigin,
    micOrigin,
    log,
    answers,
    setLatency(slot, latencyMs) {
      const entry = slots.get(slot);
      if (entry !== undefined) {
        entry.latencyMs = latencyMs;
        roster();
      }
    },
    dropMic(slot) {
      slots.get(slot)?.socket?.terminate();
    },
    async close() {
      for (const { server, wss } of [tvServer, micServer]) {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
};
