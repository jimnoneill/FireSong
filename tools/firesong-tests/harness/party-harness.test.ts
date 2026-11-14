// Headless Chrome checks for the TV side of phone app v2 (PHONE-V2.md WP-tv):
// the fun sounds rendered through the voice engine's limiter, the voice limit,
// a phone calibration on the voice engine against a fake phone that hears the
// TV, and screenshots of the party lobby at 1920x1080.
//
// The lobby uses the client's Tailwind CSS from `client/dist`, so build the
// client first (`cd client && pnpm build`). Screenshots and the measured
// numbers go to FIRESONG_ARTIFACTS (default /mnt/fast/firesong/artifacts/v2-tv).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const CLIENT = here('../../../client/');
const DIST_ASSETS = join(CLIENT, 'dist', 'assets');
const CACHE = here('../.cache/harness/');
const CHROME = process.env.FIRESONG_CHROME ?? '/usr/bin/google-chrome';
const ARTIFACTS = process.env.FIRESONG_ARTIFACTS ?? '/mnt/fast/firesong/artifacts/v2-tv';
const SOUNDS = ['applause', 'tambourine', 'cheer', 'air-horn'] as const;
const TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
};

type Measured = { peakDb: number; rmsDb: number; lengthSec: number; nan: number; expectedSec: number };

type PartyPage = {
  ready: boolean;
  renderFx(sound: string): Promise<Measured>;
  sixAtOnce(): Promise<{ accepted: boolean[]; playing: number; after: number }>;
  calibrate(
    kind: 'loopback' | 'silent',
    delaysMs: number[],
  ): Promise<{ runs: Record<string, unknown>[][]; contextState: string }>;
};

declare global {
  interface Window {
    party: PartyPage;
  }
}

let server: Server;
let origin: string;
let browser: Browser;

const styles = (): string[] =>
  existsSync(DIST_ASSETS)
    ? readdirSync(DIST_ASSETS).filter((name) => name.endsWith('.css'))
    : [];

const saveMetrics = (name: string, value: unknown) =>
  writeFileSync(join(ARTIFACTS, name), `${JSON.stringify(value, null, 2)}\n`);

beforeAll(async () => {
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(ARTIFACTS, { recursive: true });
  await build({
    entryPoints: [here('./party-entry.tsx')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    outfile: `${CACHE}party.js`,
    tsconfig: `${CLIENT}tsconfig.json`,
    nodePaths: [`${CLIENT}node_modules`],
    jsx: 'automatic',
    loader: { '.webp': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"development"' },
    logLevel: 'error',
  });
  const links = styles()
    .map((name) => `<link rel="stylesheet" href="/assets/${name}">`)
    .join('');
  const html = `<!doctype html><html lang="en" class="dark"><head><meta charset="utf-8">${links}</head><body><div id="root"></div><script type="module" src="/party.js"></script></body></html>`;
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path === '/party.html') {
      response.writeHead(200, { 'content-type': 'text/html' }).end(html);
      return;
    }
    if (path === '/party.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript' })
        .end(readFileSync(`${CACHE}party.js`));
      return;
    }
    const asset = path.startsWith('/assets/') ? join(DIST_ASSETS, path.slice('/assets/'.length)) : '';
    if (asset !== '' && !asset.includes('..') && existsSync(asset)) {
      response
        .writeHead(200, { 'content-type': TYPES[extname(asset)] ?? 'application/octet-stream' })
        .end(readFileSync(asset));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    // Without a sound card Chrome renders audio in timer-driven bursts, which
    // makes frame arrival times jitter by tens of ms; no output device at all
    // renders steadily.
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-audio-output'],
  });
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

const open = async (query = ''): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', (error) => console.error('[party pageerror]', error.message));
  await page.goto(`${origin}/party.html${query}`);
  await page.waitForFunction(() => window.party?.ready === true, undefined, { timeout: 20_000 });
  return page;
};

describe('fun sounds', () => {
  it('renders each sound through the limiter at its length, loud enough and never clipping', async () => {
    const page = await open();
    const results: [string, Measured][] = [];
    for (const sound of SOUNDS) {
      results.push([sound, await page.evaluate((name) => window.party.renderFx(name), sound)]);
    }
    saveMetrics('fx-metrics.json', Object.fromEntries(results));
    for (const [, result] of results) {
      expect(result.nan).toBe(0);
      expect(result.peakDb).toBeLessThanOrEqual(-1);
      expect(result.rmsDb).toBeGreaterThan(-40);
      expect(Math.abs(result.lengthSec - result.expectedSec)).toBeLessThanOrEqual(
        Math.max(0.2, result.expectedSec * 0.15),
      );
    }
    await page.close();
  });

  it('plays at most four at once and drops the rest', async () => {
    const page = await open();
    const result = await page.evaluate(() => window.party.sixAtOnce());
    expect(result.accepted).toEqual([true, true, true, true, false, false]);
    expect(result.playing).toBe(4);
    expect(result.after).toBe(0);
    await page.close();
  });
});

const median = (values: number[]): number => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

const doneMs = (run: Record<string, unknown>[]): number => {
  const done = run.find((frame) => frame.type === 'calibration' && frame.state === 'done');
  return Number(done?.latencyMs);
};

describe('phone-started calibration on the voice engine', () => {
  it('measures a fake phone that hears the TV 150 ms later within 20 ms', async () => {
    const page = await open();
    const delays = [0, 0, 0, 150, 150, 150, 150, 150];
    const { runs, contextState } = await page.evaluate(
      (list) => window.party.calibrate('loopback', list),
      delays,
    );
    const measured = runs.map(doneMs);
    saveMetrics('calibration-metrics.json', { delays, measured });
    expect(contextState).toBe('running');
    for (const run of runs) {
      expect(run[0]).toEqual({ type: 'calibration', slot: 3, state: 'started' });
      const latencyMs = doneMs(run);
      expect(Number.isFinite(latencyMs)).toBe(true);
      expect(run).toContainEqual({ type: 'latency', slot: 3, latencyMs, method: 'beep' });
    }
    // The fake phone's own path (WebAudio -> MediaStream -> slot tap) adds a
    // few tens of ms at 0 ms; the measured difference is its known delay.
    const path = median(measured.slice(0, 3));
    const delayed = median(measured.slice(3));
    expect(path).toBeLessThanOrEqual(60);
    expect(Math.abs(delayed - path - 150)).toBeLessThanOrEqual(20);
    await page.close();
  });

  it('reports no-tone for a phone that hears nothing', async () => {
    const page = await open();
    const { runs } = await page.evaluate(() => window.party.calibrate('silent', [0]));
    expect(runs).toEqual([
      [
        { type: 'calibration', slot: 3, state: 'started' },
        { type: 'calibration', slot: 3, state: 'failed', reason: 'no-tone' },
      ],
    ]);
    await page.close();
  });
});

describe('party lobby', () => {
  it('renders the lobby at 1920x1080 with four join codes', async () => {
    expect(styles().length, 'client/dist has no CSS: run `pnpm build` in client/ first').toBeGreaterThan(0);
    for (const [query, file] of [
      ['?lobby', 'lobby.png'],
      ['?lobby&fx', 'lobby-fx.png'],
    ] as const) {
      const page = await open(query);
      await page.waitForLoadState('networkidle');
      expect(await page.locator('dialog li img').count()).toBe(4);
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Start now');
      await page.screenshot({ path: join(ARTIFACTS, file) });
      await page.close();
    }
  });
});
