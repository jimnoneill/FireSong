// Headless Chrome harness for the TV voice engine (design §9 WP4).
//
// A fake phone page streams Chrome's fake microphone (a WAV made here with
// ffmpeg) over WebRTC to the TV page, through a minimal in-test /rtc relay.
// The TV page runs the real client modules. Checks: frames reach the
// microphone-samples bus, useMicPitch finds the tone, capture can stop and
// restart without touching tracks, the latency-locked echo sits at d_i, and
// slots are independent.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { echoSettingsFor } from '@/audio/voice-params';

import { startRelay, type Relay } from './relay';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const CLIENT = here('../../../client/');
const FAKEPHONE = here('../../fakephone/');
const CACHE = here('../.cache/harness/');
const CHROME = process.env.FIRESONG_CHROME ?? '/usr/bin/google-chrome';
const SAMPLE_RATE = 48_000;

type Harness = {
  ready: boolean;
  setPlayers(list: { captureId: string; deviceId: string; monitor: boolean }[]): void;
  devices(): Promise<{ id: string; name: string; host: string }[]>;
  snapshot(): { connected: boolean; latencyMs: Record<string, number>; lastError: string | null };
  deviceChanges(): number;
  frameTimes(captureId: string): number[];
  frameLevels(captureId: string): number[];
  pitches(captureId: string): (number | null)[];
  clearPitches(captureId: string): void;
  slotStatus(slot: number): {
    attached: boolean;
    feedbackHz: number | null;
    echo: { delayMs: number };
  } | null;
  engine(): { state: string; sampleRate: number; baseLatency: number; outputLatency: number };
  record(ms: number): Promise<number[]>;
};

type FakePhone = {
  state: { slot: number | null; connection: string; answers: number; errors: string[] };
  outbound(): Promise<{ packetsSent: number; at: number } | null>;
  trackState(): { readyState: string; enabled: boolean } | null;
  leave(sayBye: boolean): void;
};

declare global {
  interface Window {
    harness: Harness;
    fakePhone: FakePhone;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const wav = (name: string, expression: string): string => {
  const out = `${CACHE}${name}.wav`;
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=${expression}:s=${SAMPLE_RATE}:d=30`,
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    out,
  ]);
  return out;
};

const launch = (capture: string): Promise<Browser> =>
  chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${capture}`,
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });

const waitUntil = async (what: string, check: () => Promise<boolean>, timeoutMs = 20_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const openTv = async (browser: Browser, relay: Relay, query: string): Promise<Page> => {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error('[tv pageerror]', error.message));
  await page.goto(`${relay.tvOrigin}/tv.html${query}`);
  await waitUntil('TV harness ready', () => page.evaluate(() => window.harness?.ready === true));
  await waitUntil('TV seat', () => page.evaluate(() => window.harness.snapshot().connected));
  return page;
};

const joinPhone = async (browser: Browser, relay: Relay, micId: string, slot: number, tv: Page) => {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error('[phone pageerror]', error.message));
  await page.goto(`${relay.micOrigin}/phone.html?micId=${micId}&slot=${slot}&name=Tone${slot}`);
  await waitUntil(`phone ${micId} connected`, () =>
    page.evaluate(() => window.fakePhone.state.connection === 'connected'),
  );
  await waitUntil(`slot ${slot} attached on the TV`, () =>
    tv.evaluate((n) => window.harness.slotStatus(n)?.attached === true, slot),
  );
  return page;
};

/** Fraction of voiced pitch readings within ±tolerance of the target. */
const pitchAccuracy = (series: (number | null)[], target: number, tolerance = 3) => {
  const voiced = series.filter((hz): hz is number => hz !== null);
  const within = voiced.filter((hz) => Math.abs(hz - target) <= tolerance);
  return {
    voicedRatio: series.length === 0 ? 0 : voiced.length / series.length,
    withinRatio: voiced.length === 0 ? 0 : within.length / voiced.length,
    median: voiced.toSorted((a, b) => a - b)[Math.floor(voiced.length / 2)] ?? null,
  };
};

const goertzel = (samples: readonly number[], hz: number, sampleRate: number) => {
  const k = 2 * Math.cos((2 * Math.PI * hz) / sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (const x of samples) {
    const s0 = x + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - k * s1 * s2)) / samples.length;
};

const peakFrequency = (samples: readonly number[], from: number, to: number, sampleRate: number) => {
  let best = from;
  let bestLevel = -1;
  for (let hz = from; hz <= to; hz += 1) {
    const level = goertzel(samples, hz, sampleRate);
    if (level > bestLevel) {
      best = hz;
      bestLevel = level;
    }
  }
  return best;
};

/** Lag (ms) of the strongest envelope autocorrelation peak in a range. */
const echoLagMs = (samples: readonly number[], sampleRate: number, fromMs: number, toMs: number) => {
  const perMs = Math.round(sampleRate / 1000);
  const envelope: number[] = [];
  for (let i = 0; i + perMs <= samples.length; i += perMs) {
    let sum = 0;
    for (let j = i; j < i + perMs; j += 1) {
      sum += Math.abs(samples[j]);
    }
    envelope.push(sum / perMs);
  }
  const mean = envelope.reduce((a, b) => a + b, 0) / envelope.length;
  const centered = envelope.map((value) => value - mean);
  let bestLag = fromMs;
  let best = Number.NEGATIVE_INFINITY;
  for (let lag = fromMs; lag <= toMs; lag += 1) {
    let sum = 0;
    for (let i = 0; i + lag < centered.length; i += 1) {
      sum += centered[i] * centered[i + lag];
    }
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  return bestLag;
};

const maxGapMs = (times: readonly number[], from: number, to: number) => {
  const window = times.filter((t) => t >= from && t <= to);
  let gap = 0;
  for (let i = 1; i < window.length; i += 1) {
    gap = Math.max(gap, window[i] - window[i - 1]);
  }
  return gap;
};

/** Longest run of near-silent frames (audio actually missing), in ms of audio. */
const longestDropoutMs = (
  times: readonly number[],
  levels: readonly number[],
  from: number,
  to: number,
) => {
  const inWindow = levels.filter((_, index) => times[index] >= from && times[index] <= to);
  const typical = inWindow.toSorted((a, b) => a - b)[Math.floor(inWindow.length / 2)] ?? 0;
  let run = 0;
  let longest = 0;
  for (const level of inWindow) {
    run = level < typical * 0.1 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return (longest * 512 * 1000) / SAMPLE_RATE;
};

let relay: Relay;
let toneWav: string;
let lowToneWav: string;
let highToneWav: string;
let burstWav: string;
const browsers: Browser[] = [];

beforeAll(async () => {
  mkdirSync(CACHE, { recursive: true });
  toneWav = wav('tone-440', '0.5*sin(2*PI*440*t)');
  lowToneWav = wav('tone-330', '0.5*sin(2*PI*330*t)');
  highToneWav = wav('tone-550', '0.5*sin(2*PI*550*t)');
  burstWav = wav('burst-1k', "'if(lt(mod(t\\,1)\\,0.03)\\,0.6*sin(2*PI*1000*t)\\,0)'");

  await build({
    entryPoints: [here('./tv-entry.tsx')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    outfile: `${CACHE}tv.js`,
    tsconfig: `${CLIENT}tsconfig.json`,
    nodePaths: [`${CLIENT}node_modules`],
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'error',
  });
  writeFileSync(
    `${CACHE}tv.html`,
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/tv.js"></script></body></html>',
  );

});

beforeEach(async () => {
  relay = await startRelay({
    tv: {
      '/tv.html': { file: `${CACHE}tv.html`, type: 'text/html' },
      '/tv.js': { file: `${CACHE}tv.js`, type: 'text/javascript' },
    },
    mic: {
      '/phone.html': { file: `${FAKEPHONE}fakephone.html`, type: 'text/html' },
      '/fakephone.js': { file: `${FAKEPHONE}fakephone.js`, type: 'text/javascript' },
    },
  });
});

afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  await relay.close();
});

describe('TV voice engine, one phone at 440 Hz', () => {
  it('lists the phone, taps frames into the bus, tracks pitch, and survives rebinding', async () => {
    const browser = await launch(toneWav);
    browsers.push(browser);
    const tv = await openTv(browser, relay, '?tv=1');
    const micId = 'fakeA1234567';
    const phone = await joinPhone(browser, relay, micId, 1, tv);
    const deviceId = `remote:${micId}`;

    const devices = await tv.evaluate(() => window.harness.devices());
    expect(devices).toEqual([
      { id: deviceId, name: 'Slot 1 · Tone1', host: 'FireSong', channel_count: 1 },
    ]);
    expect(await tv.evaluate(() => window.harness.deviceChanges())).toBeGreaterThanOrEqual(1);

    await tv.evaluate(
      (id) => window.harness.setPlayers([{ captureId: 'p1', deviceId: id, monitor: true }]),
      deviceId,
    );
    await sleep(3500);
    const engine = await tv.evaluate(() => window.harness.engine());
    expect(engine.state).toBe('running');
    const times = await tv.evaluate(() => window.harness.frameTimes('p1'));
    const recent = times.slice(-150);
    const framesPerSec = ((recent.length - 1) / ((recent.at(-1) ?? 0) - (recent[0] ?? 0))) * 1000;
    expect(times.length).toBeGreaterThan(100);
    const levels = await tv.evaluate(() => window.harness.frameLevels('p1'));
    expect(levels.slice(-50).every((level) => level > 0.2 && level < 0.5)).toBe(true);
    expect(framesPerSec).toBeGreaterThan((engine.sampleRate / 512) * 0.8);
    expect(framesPerSec).toBeLessThan((engine.sampleRate / 512) * 1.2);

    await tv.evaluate(() => window.harness.clearPitches('p1'));
    await sleep(3000);
    const pitch = pitchAccuracy(await tv.evaluate(() => window.harness.pitches('p1')), 440);
    console.info('[440 Hz] pitch', pitch, 'engine', engine);
    expect(pitch.voicedRatio).toBeGreaterThan(0.9);
    expect(pitch.withinRatio).toBeGreaterThanOrEqual(0.9);

    const output = await tv.evaluate(() => window.harness.record(2000));
    expect(output.length).toBeGreaterThan(engine.sampleRate);
    expect(Math.abs(peakFrequency(output, 300, 600, engine.sampleRate) - 440)).toBeLessThanOrEqual(3);
    const status = await tv.evaluate(() => window.harness.slotStatus(1));
    console.info('[440 Hz] slot status', status);
    expect(Math.abs((status?.feedbackHz ?? 0) - 440)).toBeLessThan(30);

    const first = await phone.evaluate(() => window.fakePhone.outbound());
    await sleep(2000);
    const second = await phone.evaluate(() => window.fakePhone.outbound());
    const packetsPerSec =
      ((second?.packetsSent ?? 0) - (first?.packetsSent ?? 0)) /
      (((second?.at ?? 0) - (first?.at ?? 0)) / 1000);
    console.info('[440 Hz] phone packets/s', packetsPerSec.toFixed(1));

    // Pause or song change: capture stops (unbind), the stream stays up.
    await tv.evaluate(() => window.harness.setPlayers([]));
    await sleep(300);
    const stoppedAt = (await tv.evaluate(() => window.harness.frameTimes('p1'))).length;
    await sleep(700);
    expect((await tv.evaluate(() => window.harness.frameTimes('p1'))).length).toBe(stoppedAt);
    expect(await phone.evaluate(() => window.fakePhone.trackState())).toEqual({
      readyState: 'live',
      enabled: true,
    });
    expect((await tv.evaluate(() => window.harness.slotStatus(1)))?.attached).toBe(true);

    const resumeMs = await tv.evaluate(async (id) => {
      const before = window.harness.frameTimes('p1').length;
      const start = performance.now();
      window.harness.setPlayers([{ captureId: 'p1', deviceId: id, monitor: false }]);
      while (performance.now() - start < 3000) {
        const times = window.harness.frameTimes('p1');
        if (times.length > before) {
          return times[before] - start;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return Number.POSITIVE_INFINITY;
    }, deviceId);
    console.info('[440 Hz] frames resumed after', resumeMs.toFixed(1), 'ms');
    expect(resumeMs).toBeLessThan(1000);

  });
});

describe('latency-locked echo', () => {
  it('puts the audible echo at the slot d_i and follows a new calibration', async () => {
    const browser = await launch(burstWav);
    browsers.push(browser);
    const tv = await openTv(browser, relay, '?tv=1&mode=noraebang');
    const micId = 'fakeEcho1234';
    await joinPhone(browser, relay, micId, 1, tv);

    const echoState = () =>
      tv.evaluate(
        (id) => ({
          delayMs: window.harness.slotStatus(1)?.echo.delayMs ?? null,
          effectiveMs: window.harness.snapshot().latencyMs[id] ?? null,
        }),
        micId,
      );

    const measure = async (latencyMs: number) => {
      relay.setLatency(1, latencyMs);
      await waitUntil(`calibration ${latencyMs} ms applied`, async () => {
        const { effectiveMs } = await echoState();
        return effectiveMs !== null && Math.abs(effectiveMs - latencyMs) < 60;
      });
      const { sampleRate } = await tv.evaluate(() => window.harness.engine());
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await sleep(1000);
        const before = await echoState();
        const output = await tv.evaluate(() => window.harness.record(4000));
        const after = await echoState();
        if (before.delayMs === after.delayMs && before.delayMs !== null) {
          return { lag: echoLagMs(output, sampleRate, 50, 400), ...before };
        }
      }
      throw new Error('echo delay kept moving during the recording');
    };

    const delays: number[] = [];
    for (const latency of [150, 205, 40]) {
      const { lag, delayMs, effectiveMs } = await measure(latency);
      console.info(
        `[echo] calibrated ${latency} ms, effective ${String(effectiveMs)} ms, d_i ${String(delayMs)} ms -> autocorrelation peak ${lag} ms`,
      );
      expect(Math.abs((delayMs ?? 0) - echoSettingsFor(effectiveMs).delayMs)).toBeLessThan(10);
      expect(Math.abs(lag - (delayMs ?? 0))).toBeLessThanOrEqual(5);
      delays.push(delayMs ?? 0);
    }
    expect(delays[1]).toBeGreaterThan(delays[0]);
  });
});

describe('independent slots', () => {
  it('routes two phones to their own players and keeps one going when the other vanishes', async () => {
    const tvBrowser = await launch(lowToneWav);
    const otherBrowser = await launch(highToneWav);
    browsers.push(tvBrowser, otherBrowser);
    const tv = await openTv(tvBrowser, relay, '?tv=1');
    await joinPhone(tvBrowser, relay, 'fakeLow12345', 1, tv);
    const high = await joinPhone(otherBrowser, relay, 'fakeHigh1234', 2, tv);

    await tv.evaluate(() =>
      window.harness.setPlayers([
        { captureId: 'low', deviceId: 'remote:fakeLow12345', monitor: true },
        { captureId: 'high', deviceId: 'remote:fakeHigh1234', monitor: true },
      ]),
    );
    await sleep(2500);
    await tv.evaluate(() => {
      window.harness.clearPitches('low');
      window.harness.clearPitches('high');
    });
    await sleep(2500);
    const low = pitchAccuracy(await tv.evaluate(() => window.harness.pitches('low')), 330);
    const highPitch = pitchAccuracy(await tv.evaluate(() => window.harness.pitches('high')), 550);
    console.info('[two phones] low', low, 'high', highPitch);
    expect(low.withinRatio).toBeGreaterThanOrEqual(0.9);
    expect(highPitch.withinRatio).toBeGreaterThanOrEqual(0.9);

    const killAt = await tv.evaluate(() => performance.now());
    await high.evaluate(() => window.fakePhone.leave(false));
    await high.close();
    await waitUntil('slot 2 reported lost', () =>
      tv.evaluate(() => window.harness.slotStatus(2)?.attached === false),
    );
    await sleep(1500);
    const lowTimes = await tv.evaluate(() => window.harness.frameTimes('low'));
    const lowLevels = await tv.evaluate(() => window.harness.frameLevels('low'));
    const dropout = longestDropoutMs(lowTimes, lowLevels, killAt - 500, killAt + 3000);
    const gap = maxGapMs(lowTimes, killAt - 500, killAt + 3000);
    console.info(
      `[two phones] other slot around the kill: longest audio dropout ${dropout.toFixed(1)} ms, longest frame delivery gap ${gap.toFixed(1)} ms`,
    );
    expect(dropout).toBeLessThanOrEqual(50);
    expect(gap).toBeLessThanOrEqual(150);

    const highCount = (await tv.evaluate(() => window.harness.frameTimes('high'))).length;
    await sleep(1000);
    expect((await tv.evaluate(() => window.harness.frameTimes('high'))).length).toBe(highCount);
    const devices = await tv.evaluate(() => window.harness.devices());
    expect(devices.map((device) => device.id)).toEqual([
      'remote:fakeLow12345',
      'remote:fakeHigh1234',
    ]);
    expect(devices[1].name).toContain('reconnecting');
  });
});
