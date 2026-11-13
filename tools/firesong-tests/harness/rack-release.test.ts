// Headless Chrome check that releasing a MicRack slot stops its worklet
// processors. The voice engine's AudioContext is never closed, and an
// AudioWorkletNode whose process() keeps returning true runs on the audio
// thread forever, even disconnected and unreferenced.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const CLIENT = here('../../../client/');
const CACHE = here('../.cache/harness/');
const CHROME = process.env.FIRESONG_CHROME ?? '/usr/bin/google-chrome';

let server: Server;
let origin: string;
let browser: Browser;

beforeAll(async () => {
  mkdirSync(CACHE, { recursive: true });
  await build({
    entryPoints: [here('./rack-entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    outfile: `${CACHE}rack.js`,
    tsconfig: `${CLIENT}tsconfig.json`,
    nodePaths: [`${CLIENT}node_modules`],
    logLevel: 'error',
  });
  const files: Record<string, [string, string]> = {
    '/rack.html': [
      '<!doctype html><html><body><script type="module" src="/rack.js"></script></body></html>',
      'text/html',
    ],
    '/rack.js': [readFileSync(`${CACHE}rack.js`, 'utf8'), 'text/javascript'],
  };
  server = createServer((request, response) => {
    const file = files[new URL(request.url ?? '/', 'http://localhost').pathname];
    if (file === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': file[1] }).end(file[0]);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

describe('MicRack release', () => {
  it('stops the slot gate and chunker processors', async () => {
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.error('[rack pageerror]', error.message));
    await page.goto(`${origin}/rack.html`);
    await page.waitForFunction(() => typeof window.rackRelease === 'function');
    const result = await page.evaluate(() => window.rackRelease());

    expect(result.names.toSorted()).toEqual(['firesong-chunker', 'firesong-gate']);
    for (const [index, name] of result.names.entries()) {
      expect(result.live[index], `${name} posts while the slot is live`).toBeGreaterThan(0);
      expect(result.after[index], `${name} still posts after release`).toBe(result.settled[index]);
    }
  });
});
