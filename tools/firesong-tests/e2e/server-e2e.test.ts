// End-to-end run of the integrated FireSong stack on one host, headless, with
// no analyzer, no ML and no Plex:
//
// - the real server binary with its two loopback listeners and a throwaway
//   data dir;
// - a tiny UltraStar song made here (backing track, a vocals stem of A4
//   sines, and a .txt whose notes are all A4), which Nightingale imports
//   without analysis because it ships #VOCALS and #INSTRUMENTAL;
// - the real client bundle as the TV (`?tv=1&mode=noraebang&fsdiag=1`) and
//   two phones on `/m`, each in its own Chrome with a fake microphone: phone
//   1 sings 440 Hz, phone 2 sings 330 Hz.
//
// The song is started the way a phone's queue page starts it
// (add_playback_queue_entry + request_queue_playback with both phone mics),
// so the TV's own QueuePlaybackListener resolves the remote devices and
// launches playback. Logs, screenshots and report.json go to
// $FIRESONG_E2E_ARTIFACTS (default /mnt/fast/firesong/artifacts/e2e/<stamp>).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const REPO = here('../../../');
const CHROME = process.env.FIRESONG_CHROME ?? '/usr/bin/google-chrome';
const SERVER_BIN =
  process.env.FIRESONG_SERVER_BIN ??
  join(process.env.CARGO_TARGET_DIR ?? '/mnt/fast/firesong/target-int', 'debug/server');
const STAMP = new Date()
  .toISOString()
  .replaceAll(':', '-')
  .replace(/\.\d+Z$/, 'Z');
const DATA_ROOT = process.env.FIRESONG_E2E_DATA ?? '/mnt/fast/firesong/e2e-data';
const RUN_DIR = join(DATA_ROOT, `run-${STAMP}`);
const ARTIFACTS = process.env.FIRESONG_E2E_ARTIFACTS ?? `/mnt/fast/firesong/artifacts/e2e/${STAMP}`;
const TV_PORT = Number(process.env.FIRESONG_E2E_TV_PORT ?? 64480);
const PHONE_PORT = Number(process.env.FIRESONG_E2E_PHONE_PORT ?? 64481);
const RATE = 48_000;

// UltraStar timing: #BPM 300 gives a 50 ms note beat, #GAP 2000 a 2 s intro.
const BPM = 300;
const GAP_MS = 2000;
const BEAT_SEC = 60 / (BPM * 4);
const A4_PITCH = 9; // UltraStar pitch 0 is C4 (MIDI 60), so 9 is A4 = 440 Hz.
const PHRASES = 4;
const NOTES_PER_PHRASE = 3;
const NOTE_BEATS = 16; // 0.8 s
const NOTE_GAP_BEATS = 4; // 0.2 s
const PHRASE_BEATS = 80; // 4 s per phrase
const OUTRO_SEC = 3;
const WORDS = ['Fi', 're', 'song', 'sing', 'a', 'long', 'la', 'la', 'la', 'one', 'more', 'time'];

type Note = { beat: number; length: number; word: string; lineStart: boolean };

const notes: Note[] = Array.from({ length: PHRASES * NOTES_PER_PHRASE }, (_, index) => {
  const phrase = Math.floor(index / NOTES_PER_PHRASE);
  const within = index % NOTES_PER_PHRASE;
  return {
    beat: phrase * PHRASE_BEATS + within * (NOTE_BEATS + NOTE_GAP_BEATS),
    length: NOTE_BEATS,
    word: WORDS[index],
    lineStart: within === 0,
  };
});

const songSec =
  GAP_MS / 1000 +
  ((PHRASES - 1) * PHRASE_BEATS + 3 * NOTE_BEATS + 2 * NOTE_GAP_BEATS) * BEAT_SEC +
  OUTRO_SEC;

type Report = { checks: { name: string; ok: boolean; detail?: unknown }[]; [key: string]: unknown };
const report: Report = { stamp: STAMP, checks: [] };

const check = (name: string, ok: boolean, detail?: unknown) => {
  report.checks.push({ name, ok, detail });
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`,
  );
  expect(ok, `${name}: ${JSON.stringify(detail)}`).toBe(true);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async <T>(
  what: string,
  probe: () => Promise<T | null | false | undefined>,
  timeoutMs = 30_000,
) => {
  const start = Date.now();
  let last: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await probe();
      if (value !== null && value !== false && value !== undefined) {
        return value;
      }
      last = value;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
};

// ---------------------------------------------------------------- fixture --

const writeWav = (path: string, samples: Float32Array) => {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
};

const toMp3 = (wav: string, mp3: string) =>
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-i',
    wav,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    mp3,
  ]);

const sine = (seconds: number, hz: number, level: number) => {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = level * Math.sin((2 * Math.PI * hz * i) / RATE);
  }
  return out;
};

/** The UltraStar bundle: song.txt plus mix, vocals and instrumental mp3s. */
const makeSong = (folder: string) => {
  mkdirSync(folder, { recursive: true });
  const length = Math.round(songSec * RATE);
  const vocals = new Float32Array(length);
  const fade = Math.round(0.01 * RATE);
  for (const note of notes) {
    const start = Math.round((GAP_MS / 1000 + note.beat * BEAT_SEC) * RATE);
    const end = Math.round((GAP_MS / 1000 + (note.beat + note.length) * BEAT_SEC) * RATE);
    for (let i = start; i < end; i += 1) {
      const edge = Math.min(1, (i - start) / fade, (end - i) / fade);
      vocals[i] = 0.5 * edge * Math.sin((2 * Math.PI * 440 * i) / RATE);
    }
  }
  // An original backing: a soft A minor pad and a tick every 0.8 s.
  const instrumental = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / RATE;
    const pad =
      0.06 * Math.sin(2 * Math.PI * 110 * t) +
      0.04 * Math.sin(2 * Math.PI * 164.81 * t) +
      0.03 * Math.sin(2 * Math.PI * 261.63 * t);
    const sinceTick = t % 0.8;
    const tick =
      sinceTick < 0.03 ? 0.2 * Math.exp(-sinceTick * 120) * Math.sin(2 * Math.PI * 1800 * t) : 0;
    instrumental[i] = pad + tick;
  }
  const mix = instrumental.map((value, i) => value + vocals[i]);
  const wavs = join(folder, '.wav');
  mkdirSync(wavs, { recursive: true });
  for (const [name, samples] of [
    ['song', mix],
    ['vocals', vocals],
    ['instrumental', instrumental],
  ] as const) {
    writeWav(join(wavs, `${name}.wav`), samples);
    toMp3(join(wavs, `${name}.wav`), join(folder, `${name}.mp3`));
  }
  rmSync(wavs, { recursive: true, force: true });

  const lines = [
    '#TITLE:A440 Test Song',
    '#ARTIST:FireSong Fixture',
    '#LANGUAGE:English',
    `#BPM:${BPM}`,
    `#GAP:${GAP_MS}`,
    '#AUDIO:song.mp3',
    '#MP3:song.mp3',
    '#VOCALS:vocals.mp3',
    '#INSTRUMENTAL:instrumental.mp3',
  ];
  notes.forEach((note, index) => {
    if (note.lineStart && index > 0) {
      const previous = notes[index - 1];
      lines.push(`- ${previous.beat + previous.length + 4}`);
    }
    const text = note.lineStart ? note.word : ` ${note.word}`;
    lines.push(`: ${note.beat} ${note.length} ${A4_PITCH} ${text}`);
  });
  lines.push('E', '');
  writeFileSync(join(folder, 'song.txt'), lines.join('\n'));
};

const makePhoneWav = (path: string, hz: number) => writeWav(path, sine(30, hz, 0.5));

// ----------------------------------------------------------------- server --

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });

type Server = { process: ChildProcess; tv: string; phone: string; hostToken: string };

const startServer = async (dataDir: string, library: string): Promise<Server> => {
  for (const port of [TV_PORT, PHONE_PORT]) {
    if (!(await portFree(port))) {
      throw new Error(`127.0.0.1:${port} is in use; set FIRESONG_E2E_TV_PORT/PHONE_PORT`);
    }
  }
  const log = createWriteStream(join(ARTIFACTS, 'server.log'));
  const child = spawn(SERVER_BIN, [], {
    cwd: RUN_DIR,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? RUN_DIR,
      RUST_LOG: 'info,tower_http=info,server=debug',
      NIGHTINGALE_BIND: `127.0.0.1:${TV_PORT}`,
      NIGHTINGALE_REMOTE_BIND: `127.0.0.1:${PHONE_PORT}`,
      NIGHTINGALE_REMOTE_URL: `http://localhost:${PHONE_PORT}`,
      NIGHTINGALE_DATA_PATH: dataDir,
      NIGHTINGALE_LIBRARY_PATH: library,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  const tv = `http://localhost:${TV_PORT}`;
  const tokenFile = join(dataDir, 'firesong', 'host-token');
  await waitUntil('server listening and host token written', async () => {
    if (child.exitCode !== null) {
      throw new Error(`server exited with ${child.exitCode}`);
    }
    if (!existsSync(tokenFile)) {
      return null;
    }
    const response = await fetch(`${tv}/favicon.png`).catch(() => null);
    return response?.ok ?? null;
  });
  return {
    process: child,
    tv,
    phone: `http://localhost:${PHONE_PORT}`,
    hostToken: readFileSync(tokenFile, 'utf8').trim(),
  };
};

const api = async (server: Server, command: string, body: unknown = {}): Promise<unknown> => {
  const response = await fetch(`${server.tv}/api/cmd/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-firesong-host-token': server.hostToken },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${command}: HTTP ${response.status} ${text}`);
  }
  return text === '' ? null : JSON.parse(text);
};

// ---------------------------------------------------------------- browsers --

const launch = (fakeCapture: string | null): Promise<Browser> =>
  chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      ...(fakeCapture === null
        ? []
        : [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-audio-capture=${fakeCapture}`,
          ]),
    ],
  });

const logPage = (page: Page, name: string) => {
  const log = createWriteStream(join(ARTIFACTS, `${name}.console.log`));
  page.on('console', (message) => log.write(`[${message.type()}] ${message.text()}\n`));
  page.on('pageerror', (error) => log.write(`[pageerror] ${error.message}\n`));
};

const shot = async (page: Page, name: string) => {
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`) }).catch(() => undefined);
};

type Diag = {
  snapshot(): {
    connected: boolean;
    lastError: string | null;
    devices: { id: string; slot: number; label: string; reconnecting: boolean }[];
  };
  slotStatus(slot: number): { attached: boolean; monitored: boolean; levelRms: number } | null;
  engine(): { state: string; sampleRate: number };
  watchPitch(captureId: string): void;
  pitches(captureId: string): { frames: number; voiced: number; pitches: number[] } | null;
};

declare global {
  interface Window {
    fireSongDiag?: Diag;
  }
}

const median = (values: readonly number[]) =>
  values.length === 0 ? null : values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];

const within = (values: readonly number[], target: number, tolerance: number) =>
  values.length === 0
    ? 0
    : values.filter((hz) => Math.abs(hz - target) <= tolerance).length / values.length;

// ------------------------------------------------------------------- test --

describe('FireSong end to end (server + TV + two phones, no ML, no Plex)', () => {
  let server: Server | null = null;
  let completed = false;
  const browsers: Browser[] = [];

  afterAll(async () => {
    for (const browser of browsers) {
      await browser.close().catch(() => undefined);
    }
    if (server !== null) {
      server.process.kill('SIGTERM');
      await sleep(500);
      if (server.process.exitCode === null) {
        server.process.kill('SIGKILL');
      }
    }
    report.completed = completed;
    writeFileSync(join(ARTIFACTS, 'report.json'), JSON.stringify(report, null, 2));
    const failed = !completed || report.checks.some((entry) => !entry.ok);
    if (!failed && process.env.FIRESONG_E2E_KEEP !== '1') {
      rmSync(RUN_DIR, { recursive: true, force: true });
    }
    const summary = report.checks.map((entry) => `${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}`);
    process.stderr.write(
      `${summary.join('\n')}\nartifacts: ${ARTIFACTS}${failed ? `; data kept in ${RUN_DIR}` : ''}\n`,
    );
  });

  it('two phones join, sing, and the 440 Hz singer wins the noraebang reveal', async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    const dataDir = join(RUN_DIR, 'data');
    const library = join(RUN_DIR, 'library');
    mkdirSync(dataDir, { recursive: true });
    makeSong(join(library, 'FireSong Fixture - A440 Test Song'));
    copyFixture(join(library, 'FireSong Fixture - A440 Test Song'));
    const phoneWavs = [join(RUN_DIR, 'phone1-440.wav'), join(RUN_DIR, 'phone2-330.wav')];
    makePhoneWav(phoneWavs[0], 440);
    makePhoneWav(phoneWavs[1], 330);
    check('server binary exists', existsSync(SERVER_BIN), { SERVER_BIN });
    check('client bundle exists', existsSync(join(REPO, 'client/dist/index.html')));

    server = await startServer(dataDir, library);
    const active = server;

    // The library scan imports the UltraStar song without analysis.
    const song = await waitUntil('UltraStar song in the library', async () => {
      const store = await api(active, 'load_songs', {
        params: {
          search: null,
          filters: { artist: null, album: null, playlist: null, query: null },
          sort: null,
          skip: 0,
          take: 20,
        },
      });
      const songs = (store as { processed?: Record<string, unknown>[] }).processed ?? [];
      return songs.find((entry) => entry.title === 'A440 Test Song') ?? null;
    });
    report.song = song;
    check(
      'UltraStar song imported as analysed, transcript from USDX',
      song.is_analyzed === true && song.transcript_source === 'Usdx',
      {
        is_analyzed: song.is_analyzed,
        transcript_source: song.transcript_source,
        usdx: song.usdx !== null,
      },
    );

    for (const name of ['Phone One', 'Phone Two']) {
      await api(active, 'create_profile', { name });
    }

    // TV: the real client with the TV, noraebang and diagnostics flags.
    const tvBrowser = await launch(null);
    browsers.push(tvBrowser);
    const tvContext = await tvBrowser.newContext({
      viewport: { width: 960, height: 540 },
      deviceScaleFactor: 2,
    });
    const tv = await tvContext.newPage();
    logPage(tv, 'tv');
    await tv.goto(`${active.tv}/?host=${active.hostToken}&tv=1&mode=noraebang&fsdiag=1`);
    check('host token is stripped from the TV address bar', !tv.url().includes('host='), {
      url: tv.url(),
    });
    await waitUntil('TV diagnostics', () => tv.evaluate(() => window.fireSongDiag !== undefined));
    await waitUntil('TV seat on /rtc', () =>
      tv.evaluate(() => window.fireSongDiag?.snapshot().connected ?? false),
    );

    // Phones: the QR links from mic-links, each in its own browser and mic.
    const linksResponse = await fetch(`${active.tv}/api/firesong/mic-links`, {
      headers: { 'x-firesong-host-token': active.hostToken },
    });
    const links = (await linksResponse.json()) as { slots: { slot: number; url: string | null }[] };
    const phones: Page[] = [];
    for (const [index, wav] of phoneWavs.entries()) {
      const url = links.slots[index].url;
      check(
        `mic link for slot ${index + 1} points at the phone door`,
        url?.startsWith(`${active.phone}/m?t=`) === true,
        {
          slot: index + 1,
          base: url?.slice(0, url.indexOf('?')),
        },
      );
      const browser = await launch(wav);
      browsers.push(browser);
      const context: BrowserContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      });
      const phone = await context.newPage();
      logPage(phone, `phone${index + 1}`);
      await phone.goto(url ?? '');
      await phone.getByLabel(/name/i).fill(index === 0 ? 'Alto' : 'Tenor');
      await phone.getByRole('button', { name: /^Join as/ }).click();
      phones.push(phone);
    }

    const joined = await waitUntil('both phones in the TV roster', () =>
      tv.evaluate(() => {
        const devices = window.fireSongDiag?.snapshot().devices ?? [];
        return devices.length === 2 && devices.every((device) => !device.reconnecting)
          ? devices
          : null;
      }),
    );
    const slots = joined.map((device) => device.slot).toSorted();
    check('both phones join distinct slots', slots[0] === 1 && slots[1] === 2, { devices: joined });

    for (const [index, phone] of phones.entries()) {
      await waitUntil(
        `phone ${index + 1} live`,
        () => phone.getByText('Live on the TV').isVisible(),
        20_000,
      );
    }
    const attached = await waitUntil('both slots attached with audio on the TV', () =>
      tv.evaluate(() => {
        const status = [1, 2].map((slot) => window.fireSongDiag?.slotStatus(slot) ?? null);
        return status.every((entry) => entry !== null && entry.attached && entry.levelRms > 0.01)
          ? status
          : null;
      }),
    );
    check('RTC connections are up: phones live, TV slots attached with audio', true, {
      tv: attached,
    });
    await shot(tv, '01-tv-menu-phones-joined');
    for (const [index, phone] of phones.entries()) {
      await shot(phone, `02-phone${index + 1}-live`);
    }

    // Start the song the way a phone's queue page does.
    const deviceFor = (slot: number) => joined.find((device) => device.slot === slot)?.id ?? '';
    await tv.evaluate(() => {
      window.fireSongDiag?.watchPitch('p1');
      window.fireSongDiag?.watchPitch('p2');
    });
    await api(active, 'add_playback_queue_entry', {
      fileHash: song.file_hash,
      tempo: 1,
      keyOffset: 0,
    });
    await api(active, 'request_queue_playback', {
      players: [
        { id: 'p1', profile: 'Phone One', microphoneId: deviceFor(1), color: 'rose' },
        { id: 'p2', profile: 'Phone Two', microphoneId: deviceFor(2), color: 'fuchsia' },
      ],
    });
    await waitUntil(
      'TV on /playback',
      async () => new URL(tv.url()).pathname === '/playback',
      20_000,
    );
    const startedAt = Date.now();
    check('the TV starts the queued song on /playback', true);

    // Mid-song: each player's frames carry its own phone's pitch.
    await sleep(Math.min(10_000, (songSec * 1000) / 2));
    await shot(tv, '03-tv-mid-song');
    const pitches = await tv.evaluate(() => ({
      p1: window.fireSongDiag?.pitches('p1') ?? null,
      p2: window.fireSongDiag?.pitches('p2') ?? null,
    }));
    const p1 = pitches.p1?.pitches ?? [];
    const p2 = pitches.p2?.pitches ?? [];
    report.pitch = {
      p1: {
        frames: pitches.p1?.frames,
        voiced: pitches.p1?.voiced,
        median: median(p1),
        within3Hz: within(p1, 440, 3),
      },
      p2: {
        frames: pitches.p2?.frames,
        voiced: pitches.p2?.voiced,
        median: median(p2),
        within3Hz: within(p2, 330, 3),
      },
    };
    check(
      'pitch is detected per slot (player 1 at 440 Hz, player 2 at 330 Hz)',
      p1.length >= 50 && p2.length >= 50 && within(p1, 440, 3) >= 0.9 && within(p2, 330, 3) >= 0.9,
      report.pitch,
    );

    // Song end: the noraebang reveal runs, then ranks the singers.
    await waitUntil(
      'noraebang reveal',
      () => tv.locator('[aria-labelledby="noraebang-reveal-title"]').isVisible(),
      (songSec + 20) * 1000 - (Date.now() - startedAt),
    );
    await shot(tv, '04-tv-reveal-rolling');
    const ranked = await waitUntil(
      'ranked scores',
      async () => {
        const list = tv.locator('[data-testid="ranked-scores"] li');
        return (await list.count()) === 2 ? list.allInnerTexts() : null;
      },
      30_000,
    );
    await shot(tv, '05-tv-reveal-ranked');
    report.ranked = ranked;

    const results = [];
    for (const [index, phone] of phones.entries()) {
      const card = phone.locator('[aria-labelledby="phone-mic-result"]');
      await waitUntil(`phone ${index + 1} song result`, () => card.isVisible(), 15_000);
      const score = Number((await card.locator('p.text-7xl').innerText()).replace(/[^\d]/g, ''));
      results.push({ phone: index + 1, displayScore: score, text: await card.innerText() });
      await shot(phone, `06-phone${index + 1}-result`);
    }
    report.phoneResults = results;
    check(
      'each phone shows its own song result',
      results.every((entry) => Number.isFinite(entry.displayScore)),
      results,
    );
    check(
      'phone 1 (440 Hz) outscores phone 2 (330 Hz)',
      results[0].displayScore > results[1].displayScore,
      results,
    );
    check(
      'the reveal ranks the 440 Hz singer first',
      ranked[0]?.includes('Alto') === true || ranked[0]?.includes('Phone One') === true,
      ranked,
    );

    // Profiles keep Nightingale's raw 0-1000 score.
    type ScoreRecord = { profile: string; song_hash: string; score: number };
    const profiles = await waitUntil(
      'scores saved to both profiles',
      async () => {
        const store = (await api(active, 'load_profiles')) as { scores?: ScoreRecord[] };
        const mine = (store.scores ?? []).filter((record) => record.song_hash === song.file_hash);
        return mine.length >= 2 ? mine : null;
      },
      15_000,
    );
    report.profileScores = profiles;
    const raw = (name: string): number | null =>
      profiles.findLast((record) => record.profile === name)?.score ?? null;
    const raw1 = raw('Phone One');
    const raw2 = raw('Phone Two');
    check(
      'raw scores are saved to both profiles and keep the order',
      raw1 !== null && raw2 !== null && raw1 > raw2 && raw1 <= 1000,
      {
        raw1,
        raw2,
      },
    );

    // No secret reaches the server log (PROTOCOL.md §2.3).
    const pairingToken = new URL(links.slots[0].url ?? 'http://x/').searchParams.get('t') ?? '';
    const serverLog = readFileSync(join(ARTIFACTS, 'server.log'), 'utf8');
    check(
      'server log holds neither the host token nor the pairing token',
      pairingToken.length === 32 &&
        !serverLog.includes(active.hostToken) &&
        !serverLog.includes(pairingToken),
      { logBytes: serverLog.length },
    );
    completed = true;
  });
});

/** Keeps a copy of the generated song with the artifacts, for inspection. */
function copyFixture(folder: string) {
  const out = join(ARTIFACTS, 'fixture');
  mkdirSync(out, { recursive: true });
  for (const name of ['song.txt', 'song.mp3', 'vocals.mp3', 'instrumental.mp3']) {
    writeFileSync(join(out, name), readFileSync(join(folder, name)));
  }
}
