// Mock of the FireSong server for the phone-page e2e test: two loopback
// listeners like the real server (phone door and TV door), static files from
// client/dist with the SPA fallback, the pairing-token cookie on the phone
// door, and /rtc implementing the slot registry and relay of
// docs/firesong/PROTOCOL.md §4-6. Test code drives it directly.
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

import { acceptUpgrade } from './ws-server.mjs';

const SLOTS = [1, 2, 3, 4];
const COLORS = { 1: 'rose', 2: 'fuchsia', 3: 'amber', 4: 'emerald' };
const RESERVATION_MS = 600_000;
const MIC_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json',
};
const COOKIE = 'nightingale_remote';

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

const cookieToken = (header) =>
  (header ?? '')
    .split(';')
    .map((pair) => pair.trim().split('='))
    .find(([name]) => name === COOKIE)?.[1];

export async function startMockRelay({ distDir, extraFiles = {}, token }) {
  const log = [];
  const sockets = new Set();
  const slots = new Map();
  let tv = null;
  const record = (dir, role, frame) => log.push({ at: Date.now(), dir, role, frame });

  const sendTo = (conn, role, frame) => {
    record('out', role, frame);
    conn.sendJson(frame);
  };
  const toTv = (frame) => {
    if (tv !== null) sendTo(tv, 'tv', frame);
  };
  const roster = () =>
    SLOTS.map((slot) => {
      const entry = slots.get(slot);
      if (entry === undefined) return { slot, color: COLORS[slot], state: 'empty', muted: false };
      return {
        slot,
        color: COLORS[slot],
        state: entry.conn === null ? 'reserved' : 'connected',
        micId: entry.micId,
        ...(entry.name === undefined ? {} : { name: entry.name }),
        muted: entry.muted,
      };
    });
  const sendRoster = () => toTv({ type: 'roster', slots: roster() });
  const entryOf = (conn) => [...slots.values()].find((entry) => entry.conn === conn);
  const fail = (conn, role, code, closeCode) => {
    sendTo(conn, role, { type: 'error', code });
    if (closeCode !== undefined) conn.close(closeCode);
  };

  const pickSlot = (wanted) => {
    const empty = SLOTS.filter((slot) => !slots.has(slot));
    if (wanted !== undefined && empty.includes(wanted)) return wanted;
    if (empty.length > 0) return empty[0];
    const reserved = [...slots.values()].filter((entry) => entry.conn === null);
    const sameSlot = reserved.find((entry) => entry.slot === wanted);
    const victim = sameSlot ?? reserved.sort((a, b) => a.reservedUntil - b.reservedUntil)[0];
    if (victim === undefined) return null;
    slots.delete(victim.slot);
    toTv({ type: 'slot-lost', slot: victim.slot, micId: victim.micId, reason: 'evicted' });
    return victim.slot;
  };

  const micHello = (conn, frame) => {
    if (frame.v !== 1) return fail(conn, 'mic', 'version', 4400);
    if (typeof frame.micId !== 'string' || !MIC_ID.test(frame.micId)) {
      return fail(conn, 'mic', 'bad-hello', 4400);
    }
    let entry = [...slots.values()].find((each) => each.micId === frame.micId);
    let reclaimed = false;
    if (entry !== undefined) {
      if (frame.resumeKey !== entry.resumeKey) return fail(conn, 'mic', 'bad-resume', 4403);
      if (entry.conn !== null && entry.conn !== conn) {
        sendTo(entry.conn, 'mic', { type: 'slot-lost', reason: 'replaced' });
        entry.conn.close(4409);
        toTv({ type: 'slot-lost', slot: entry.slot, micId: entry.micId, reason: 'replaced' });
      }
      reclaimed = true;
    } else {
      const slot = pickSlot(frame.slot);
      if (slot === null) return fail(conn, 'mic', 'slots-full', 4503);
      entry = {
        slot,
        micId: frame.micId,
        resumeKey: randomBytes(16).toString('hex'),
        muted: false,
        mutedBy: 'mic',
      };
      slots.set(slot, entry);
    }
    entry.conn = conn;
    entry.reservedUntil = undefined;
    if (typeof frame.name === 'string') entry.name = frame.name;
    sendTo(conn, 'mic', {
      type: 'assign',
      v: 1,
      slot: entry.slot,
      color: COLORS[entry.slot],
      micId: entry.micId,
      resumeKey: entry.resumeKey,
      reclaimed,
      tvConnected: tv !== null,
      iceServers: [],
    });
    if (entry.muted) sendTo(conn, 'mic', { type: 'mute', muted: true, by: entry.mutedBy });
    sendRoster();
  };

  const micFrame = (conn, frame) => {
    const entry = entryOf(conn);
    if (entry === undefined) return fail(conn, 'mic', 'no-hello', 4408);
    const stamp = { slot: entry.slot, micId: entry.micId };
    switch (frame.type) {
      case 'offer':
        if (tv === null) return fail(conn, 'mic', 'no-tv');
        return toTv({ type: 'offer', ...stamp, sdp: frame.sdp, restart: frame.restart === true });
      case 'ice':
        return toTv({ type: 'ice', ...stamp, candidate: frame.candidate ?? null });
      case 'diag':
        return toTv({ type: 'diag', ...stamp, data: frame.data });
      case 'mute':
        entry.muted = frame.muted === true;
        entry.mutedBy = 'mic';
        toTv({ type: 'mute', slot: entry.slot, muted: entry.muted, by: 'mic' });
        return sendRoster();
      case 'bye':
        slots.delete(entry.slot);
        entry.conn = null;
        conn.close(1000);
        toTv({ type: 'slot-lost', ...stamp, reason: 'bye' });
        return sendRoster();
      case 'ping':
        return sendTo(conn, 'mic', { type: 'pong', t: frame.t });
      default:
        return fail(conn, 'mic', 'bad-frame');
    }
  };

  const phoneOf = (slot) => slots.get(slot)?.conn ?? null;

  const tvFrame = (conn, frame) => {
    const phone = phoneOf(frame.slot);
    switch (frame.type) {
      case 'answer':
      case 'restart':
      case 'ice':
        if (phone === null) return frame.type === 'ice' ? undefined : fail(conn, 'tv', 'unknown-slot');
        return sendTo(phone, 'mic', {
          type: frame.type,
          ...(frame.type === 'answer' ? { sdp: frame.sdp } : {}),
          ...(frame.type === 'ice' ? { candidate: frame.candidate ?? null } : {}),
        });
      case 'mute': {
        const entry = slots.get(frame.slot);
        if (entry === undefined) return fail(conn, 'tv', 'unknown-slot');
        entry.muted = frame.muted === true;
        entry.mutedBy = 'tv';
        if (phone !== null) sendTo(phone, 'mic', { type: 'mute', muted: entry.muted, by: 'tv' });
        return sendRoster();
      }
      case 'song-result':
        return relaySongResult(frame);
      case 'ping':
        return sendTo(conn, 'tv', { type: 'pong', t: frame.t });
      default:
        return fail(conn, 'tv', 'bad-frame');
    }
  };

  const relaySongResult = (frame) => {
    for (const result of frame.results) {
      const phone = phoneOf(result.slot);
      if (phone === null) continue;
      sendTo(phone, 'mic', {
        type: 'song-result',
        displayScore: result.displayScore,
        rawScore: result.rawScore,
        tier: result.tier,
        ...(result.rank === undefined ? {} : { rank: result.rank }),
        singers: frame.results.length,
        ...(frame.title === undefined ? {} : { title: frame.title }),
      });
    }
  };

  const onMicConnection = (conn) => {
    let helloSeen = false;
    conn.on('text', (text) => {
      const frame = JSON.parse(text);
      record('in', 'mic', frame);
      if (!helloSeen) {
        if (frame.type !== 'hello') return fail(conn, 'mic', 'no-hello', 4408);
        helloSeen = true;
        return micHello(conn, frame);
      }
      return micFrame(conn, frame);
    });
    conn.on('close', (code) => {
      record('close', 'mic', { code });
      const entry = entryOf(conn);
      if (entry === undefined) return;
      entry.conn = null;
      entry.reservedUntil = Date.now() + RESERVATION_MS;
      toTv({ type: 'slot-lost', slot: entry.slot, micId: entry.micId, reason: 'disconnected' });
      sendRoster();
    });
  };

  const broadcastTvState = (connected) => {
    for (const entry of slots.values()) {
      if (entry.conn !== null) sendTo(entry.conn, 'mic', { type: 'tv-state', connected });
    }
  };

  const onTvConnection = (conn) => {
    conn.on('text', (text) => {
      const frame = JSON.parse(text);
      record('in', 'tv', frame);
      if (frame.type === 'hello') {
        if (tv !== null && tv !== conn) {
          sendTo(tv, 'tv', { type: 'error', code: 'tv-replaced' });
          tv.close(4409);
        }
        tv = conn;
        sendTo(conn, 'tv', { type: 'ready', v: 1, iceServers: [] });
        sendRoster();
        return broadcastTvState(true);
      }
      return tvFrame(conn, frame);
    });
    conn.on('close', (code) => {
      record('close', 'tv', { code });
      if (tv === conn) {
        tv = null;
        broadcastTvState(false);
      }
    });
  };

  const serveFile = async (response, file) => {
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'content-length': body.length,
    });
    response.end(body);
  };

  const staticHandler = async (request, response) => {
    const url = new URL(request.url, 'http://local');
    if (extraFiles[url.pathname] !== undefined) {
      return serveFile(response, extraFiles[url.pathname]);
    }
    const file = path.resolve(distDir, `.${decodeURIComponent(url.pathname)}`);
    const inside = file.startsWith(`${path.resolve(distDir)}${path.sep}`);
    const isFile = inside && (await stat(file).catch(() => null))?.isFile() === true;
    return serveFile(response, isFile ? file : path.join(distDir, 'index.html'));
  };

  const phoneAuthorised = (request) => {
    const url = new URL(request.url, 'http://local');
    return url.searchParams.get('t') === token || cookieToken(request.headers.cookie) === token;
  };

  const phoneServer = createServer((request, response) => {
    if (!phoneAuthorised(request)) {
      response.writeHead(401).end('remote link is not valid');
      return;
    }
    if (new URL(request.url, 'http://local').searchParams.get('t') === token) {
      response.setHeader('set-cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`);
    }
    staticHandler(request, response).catch((error) => response.writeHead(500).end(String(error)));
  });
  const tvServer = createServer((request, response) => {
    staticHandler(request, response).catch((error) => response.writeHead(500).end(String(error)));
  });

  phoneServer.on('upgrade', (request, socket) => {
    if (!phoneAuthorised(request) || !request.url.startsWith('/rtc')) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const conn = acceptUpgrade(request, socket);
    if (conn !== null) {
      sockets.add(conn);
      onMicConnection(conn);
    }
  });
  tvServer.on('upgrade', (request, socket) => {
    const conn = request.url.startsWith('/rtc') ? acceptUpgrade(request, socket) : null;
    if (conn !== null) {
      sockets.add(conn);
      onTvConnection(conn);
    }
  });

  const phonePort = await listen(phoneServer);
  const tvPort = await listen(tvServer);

  return {
    token,
    phoneOrigin: `http://127.0.0.1:${phonePort}`,
    tvOrigin: `http://127.0.0.1:${tvPort}`,
    log,
    slot: (slot) => {
      const entry = slots.get(slot);
      return entry === undefined
        ? null
        : { micId: entry.micId, connected: entry.conn !== null, muted: entry.muted, name: entry.name };
    },
    /** Drops the phone's TCP connection without a close frame (Wi-Fi blip). */
    killPhone: (slot) => phoneOf(slot)?.kill(),
    sendSongResult: (frame) => {
      record('in', 'tv', { type: 'song-result', ...frame });
      relaySongResult(frame);
    },
    framesFrom: (role, type) =>
      log.filter((entry) => entry.dir === 'in' && entry.role === role && entry.frame.type === type),
    close: async () => {
      sockets.forEach((conn) => conn.kill());
      for (const server of [phoneServer, tvServer]) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}
