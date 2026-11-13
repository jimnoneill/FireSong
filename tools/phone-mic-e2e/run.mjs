// FireSong WP5 e2e: the phone /m page in headless Chrome with iPhone-sized
// mobile emulation and a fake microphone, joining through a mock /rtc relay
// and streaming to a mock TV page in the same browser.
//
// Usage: node tools/phone-mic-e2e/run.mjs   (after `pnpm --dir client build`)
// Env:   CHROME (default /usr/bin/google-chrome), FIRESONG_E2E_OUT (report dir)
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Chrome } from './cdp.mjs';
import { startMockRelay } from './mock-relay.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '../../client/dist');
const chromePath = process.env.CHROME ?? '/usr/bin/google-chrome';
const outRoot =
  process.env.FIRESONG_E2E_OUT ??
  path.join(process.env.FIRESONG_FAST_ROOT ?? os.tmpdir(), 'logs', 'phone-page-e2e');
const outDir = path.join(outRoot, new Date().toISOString().replace(/[:.]/g, '-'));
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const SLOT = 2;
const HEARD_RMS = 0.01;
const SILENT_RMS = 0.004;

const checks = [];
const timings = {};
const check = (name, ok, detail = {}) => {
  checks.push({ name, ok: Boolean(ok), ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${Object.keys(detail).length ? `  ${JSON.stringify(detail)}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 48 kHz mono 16-bit WAV: 440 Hz with a 1.5 Hz swell, so the meter must move. */
async function writeTestTone(file) {
  const rate = 48_000;
  const seconds = 4;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const t = i / rate;
    const envelope = 0.05 + 0.55 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 1.5 * t));
    data.writeInt16LE(Math.round(envelope * Math.sin(2 * Math.PI * 440 * t) * 32_767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  await writeFile(file, Buffer.concat([header, data]));
}

const buttonByText = (text) =>
  `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
const bodyHas = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`;
const tvSlot = (field) => `window.tvMock?.slots?.[${SLOT}]?.${field}`;

async function largestScript() {
  const assets = path.join(distDir, 'assets');
  const files = (await readdir(assets)).filter((name) => name.endsWith('.js'));
  const sized = await Promise.all(
    files.map(async (name) => ({ name, size: (await stat(path.join(assets, name))).size })),
  );
  return sized.sort((a, b) => b.size - a.size)[0];
}

async function sampleMeter(phone, ms) {
  const values = [];
  const end = performance.now() + ms;
  while (performance.now() < end) {
    values.push(await phone.evaluate(`document.querySelector('meter')?.value ?? -1`));
    await sleep(100);
  }
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    distinct: new Set(values).size,
    samples: values.length,
  };
}

async function main() {
  await access(path.join(distDir, 'index.html')).catch(() => {
    throw new Error(`no client build at ${distDir}; run pnpm --dir client build first`);
  });
  await mkdir(outDir, { recursive: true });
  const tone = path.join(outDir, 'tone.wav');
  await writeTestTone(tone);

  const token = randomBytes(16).toString('hex');
  const relay = await startMockRelay({
    distDir,
    token,
    extraFiles: { '/tv-mock.html': path.join(here, 'tv-mock.html') },
  });
  const profile = path.join(outDir, 'chrome-profile');
  const chromeLog = createWriteStream(path.join(outDir, 'chrome.log'));
  const chrome = Chrome.launch(
    chromePath,
    [
      '--headless=new',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=en-US',
      '--mute-audio',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${tone}`,
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
    chromeLog,
  );

  let tv;
  let phone;
  try {
    tv = await chrome.newPage();
    await tv.navigate(`${relay.tvOrigin}/tv-mock.html`);
    await tv.waitFor('window.tvMock?.ready === true', { what: 'TV mock ready' });

    phone = await chrome.newPage();
    await phone.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await phone.send('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA, platform: 'iPhone' });
    await phone.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await phone.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const devices = navigator.mediaDevices;
        const original = devices.getUserMedia.bind(devices);
        window.__e2e = { gum: 0, streams: [], constraints: [] };
        devices.getUserMedia = async (constraints) => {
          window.__e2e.constraints.push(constraints);
          const stream = await original(constraints);
          window.__e2e.gum += 1;
          window.__e2e.streams.push(stream);
          return stream;
        };
      })();`,
    });

    await joinFlow({ relay, tv, phone });
    await meterAndAudio({ relay, tv, phone });
    await trackRecovery({ relay, tv, phone });
    await muteFlow({ relay, tv, phone });
    await socketKill({ relay, tv, phone });
    await tvReload({ relay, tv, phone });
    await songResult({ relay, phone });
    await leaveFlow({ relay, phone });
  } catch (error) {
    check('run completed without an exception', false, { error: String(error?.stack ?? error) });
  } finally {
    await writeFile(
      path.join(outDir, 'report.json'),
      JSON.stringify(
        {
          checks,
          timings,
          phoneConsole: phone?.console ?? [],
          tvConsole: tv?.console ?? [],
          relayLog: relay.log.map((entry) => ({
            ...entry,
            frame: { ...entry.frame, ...(entry.frame.sdp ? { sdp: `${entry.frame.sdp.length} bytes` } : {}) },
          })),
        },
        null,
        2,
      ),
    );
    await chrome.close();
    await relay.close();
    chromeLog.end();
    await rm(profile, { recursive: true, force: true });
  }

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Report: ${outDir}/report.json`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

async function joinFlow({ relay, phone }) {
  await phone.navigate(`${relay.phoneOrigin}/m?t=${relay.token}&slot=${SLOT}`);
  const join = await phone.waitFor(`${bodyHas('Join as Fuchsia mic')}`, { what: 'join button' });
  check('join card offers the QR slot colour', join.value, { text: 'Join as Fuchsia mic' });
  check('pairing token is removed from the address bar', (await phone.evaluate('location.search')) === `?slot=${SLOT}`);

  const biggest = await largestScript();
  const scripts = await phone.evaluate(`performance.getEntriesByType('resource')
    .filter((entry) => entry.name.endsWith('.js'))
    .map((entry) => ({ name: entry.name.split('/').pop(), bytes: entry.encodedBodySize }))`);
  const scriptBytes = scripts.reduce((sum, entry) => sum + entry.bytes, 0);
  check('phone loads only the small bundle', !scripts.some((entry) => entry.name === biggest.name) && scriptBytes < 1_000_000, {
    scriptBytes,
    scripts: scripts.map((entry) => entry.name),
    fullClientChunk: `${biggest.name} (${biggest.size} bytes, not loaded)`,
  });
  await writeFile(path.join(outDir, 'phone-join.png'), await phone.screenshot());

  await phone.evaluate(`document.querySelector('input').focus()`);
  await phone.send('Input.insertText', { text: 'Jim' });

  const started = performance.now();
  await phone.tap(`document.querySelector('button[type=submit]')`);
  const live = await phone.waitFor(bodyHas('Live on the TV'), { timeoutMs: 10_000, what: 'live' });
  timings.joinToLiveMs = Math.round(performance.now() - started);
  check('tap to live on the TV in under 5 s', live.value && timings.joinToLiveMs < 5_000, {
    ms: timings.joinToLiveMs,
  });

  check('song queue opens the existing /q page in a new tab', await phone.evaluate(`document.querySelector('a[href="/q"][target="_blank"]') !== null`));

  const hello = relay.framesFrom('mic', 'hello').at(-1)?.frame;
  check('hello carries micId, QR slot and name', hello?.slot === SLOT && hello?.name === 'Jim' && /^[\w-]{8,64}$/.test(hello?.micId), { hello });
  const constraints = await phone.evaluate('window.__e2e.constraints[0]');
  const audio = constraints?.audio ?? {};
  check(
    'capture asks for raw mono audio',
    audio.echoCancellation === false && audio.noiseSuppression === false && audio.autoGainControl === false && audio.channelCount === 1,
    { audio },
  );
  const offer = relay.framesFrom('mic', 'offer').at(-1)?.frame;
  const sdp = offer?.sdp ?? '';
  const fmtp = new Set(/a=fmtp:111 (.*)/.exec(sdp)?.[1]?.split(';') ?? []);
  const wanted = ['minptime=10', 'useinbandfec=1', 'usedtx=0', 'stereo=0', 'maxaveragebitrate=64000'];
  check('offer carries the Opus 10 ms parameters', /a=ptime:10/.test(sdp) && wanted.every((param) => fmtp.has(param)), {
    restart: offer?.restart,
    opusLines: sdp.split(/\r?\n/).filter((line) => /^a=(fmtp:111|ptime)/.test(line)),
  });
}

async function meterAndAudio({ relay, tv, phone }) {
  const meter = await sampleMeter(phone, 3_000);
  check('input level meter moves', meter.max - meter.min >= 15 && meter.distinct >= 5, meter);

  const heard = await tv.waitFor(`(${tvSlot('rms')} ?? 0) > ${HEARD_RMS}`, { what: 'TV hears the phone' });
  check('TV receives the phone audio', heard.value, { maxRms: await tv.evaluate(tvSlot('maxRms')) });

  await sleep(2_500);
  const pps = await tv.evaluate(tvSlot('packetsPerSecond'));
  const diag = relay.framesFrom('mic', 'diag').at(-1)?.frame?.data;
  timings.packetsPerSecond = Math.round(pps);
  check('phone sends 10 ms Opus packets (about 100 per second)', pps > 80 && pps < 120, {
    packetsPerSecond: Math.round(pps),
    answerPtime: diag?.peer?.answerPtime,
  });
  check('phone reports diag to the TV', diag?.media?.channelCount !== undefined, { media: diag?.media });
}

async function trackRecovery({ relay, tv, phone }) {
  const offersBefore = relay.framesFrom('mic', 'offer').length;
  const started = performance.now();
  const gumBefore = await phone.evaluate(`(() => {
    const track = window.__e2e.streams.at(-1).getAudioTracks()[0];
    track.stop();
    track.dispatchEvent(new Event('ended'));
    return window.__e2e.gum;
  })()`);

  await phone.waitFor(`window.__e2e.gum > ${gumBefore}`, { intervalMs: 10, what: 'new capture' });
  timings.trackEndToNewCaptureMs = Math.round(performance.now() - started);
  await sleep(1_500);
  const sending = await phone.evaluate(`(() => {
    const [old, current] = window.__e2e.streams.slice(-2).map((stream) => stream.getAudioTracks()[0]);
    return { old: old.readyState, current: current.readyState };
  })()`);
  const rms = await tv.evaluate(`${tvSlot('rms')} ?? 0`);
  const offersAfter = relay.framesFrom('mic', 'offer').length;
  check(
    'ended track recovers through replaceTrack in under 3 s',
    timings.trackEndToNewCaptureMs < 3_000 && sending.old === 'ended' && sending.current === 'live' && rms > HEARD_RMS && offersAfter === offersBefore,
    { newCaptureMs: timings.trackEndToNewCaptureMs, tracks: sending, tvRmsAfter1500ms: rms, newOffers: offersAfter - offersBefore },
  );
  const meter = await sampleMeter(phone, 1_500);
  check('meter follows the new track', meter.max - meter.min >= 10, meter);
}

async function muteFlow({ relay, tv, phone }) {
  await phone.tap(buttonByText('Mute'));
  await phone.waitFor(`${buttonByText('Unmute')} !== undefined`, { what: 'unmute button' });
  const muteFrame = relay.framesFrom('mic', 'mute').at(-1)?.frame;
  const silent = await tv.waitFor(`(${tvSlot('rms')} ?? 1) < ${SILENT_RMS}`, { timeoutMs: 3_000, what: 'TV silence' });
  check('mute reaches the server and silences the TV', muteFrame?.muted === true && silent.value && relay.slot(SLOT)?.muted === true, {
    ms: Math.round(silent.ms),
  });

  await phone.tap(buttonByText('Unmute'));
  await tv.waitFor(`(${tvSlot('rms')} ?? 0) > ${HEARD_RMS}`, { timeoutMs: 3_000, what: 'audio after unmute' });
  check('unmute restores audio', relay.framesFrom('mic', 'mute').at(-1)?.frame?.muted === false);
}

async function socketKill({ relay, tv, phone }) {
  const before = relay.slot(SLOT);
  const assigned = relay.log.filter((entry) => entry.dir === 'out' && entry.frame.type === 'assign').at(-1)?.frame;
  const hellos = relay.framesFrom('mic', 'hello').length;
  relay.killPhone(SLOT);
  const started = performance.now();

  await phone.waitFor(bodyHas('Reconnecting'), { timeoutMs: 3_000, what: 'reconnecting status' }).catch(() => null);
  await tv.waitFor(`${tvSlot('connectionState')} === 'connected' && (${tvSlot('rms')} ?? 0) > ${HEARD_RMS}`, {
    timeoutMs: 15_000,
    what: 'audio after socket kill',
  });
  await phone.waitFor(bodyHas('Live on the TV'), { what: 'phone live again' });
  timings.socketKillToAudioMs = Math.round(performance.now() - started);
  const hello = relay.framesFrom('mic', 'hello').at(-1)?.frame;
  const reassigned = relay.log.filter((entry) => entry.dir === 'out' && entry.frame.type === 'assign').at(-1)?.frame;
  check('socket drop re-hellos into the same slot', relay.framesFrom('mic', 'hello').length === hellos + 1 && hello?.micId === before?.micId && hello?.resumeKey === assigned?.resumeKey && reassigned?.slot === SLOT && reassigned?.reclaimed === true, {
    ms: timings.socketKillToAudioMs,
    slot: reassigned?.slot,
    reclaimed: reassigned?.reclaimed,
  });
}

async function tvReload({ relay, tv, phone }) {
  const offers = relay.framesFrom('mic', 'offer').length;
  const started = performance.now();
  await tv.navigate(`${relay.tvOrigin}/tv-mock.html`);
  await tv.waitFor(`window.tvMock?.ready === true && ${tvSlot('connectionState')} === 'connected' && (${tvSlot('rms')} ?? 0) > ${HEARD_RMS}`, {
    timeoutMs: 10_000,
    what: 'audio after TV reload',
  });
  timings.tvReloadToAudioMs = Math.round(performance.now() - started);
  check('a reloaded TV gets a fresh offer without a tap', relay.framesFrom('mic', 'offer').length > offers && (await phone.evaluate(bodyHas('Live on the TV'))), {
    ms: timings.tvReloadToAudioMs,
  });
}

async function songResult({ relay, phone }) {
  relay.sendSongResult({
    title: 'Test Song',
    results: [
      { slot: SLOT, displayScore: 96, rawScore: 812, tier: 'excellent', rank: 1 },
      { slot: 3, displayScore: 71, rawScore: 540, tier: 'good', rank: 2 },
    ],
  });
  const shown = await phone.waitFor(`${bodyHas('Your score')} && ${bodyHas('96')} && ${bodyHas('훌륭해요!')}`, {
    what: 'song result',
  });
  check('song result is rendered with score and tier caption', shown.value, {
    rank: await phone.evaluate(bodyHas('#1 of 2')),
    title: await phone.evaluate(bodyHas('Test Song')),
  });
  await writeFile(path.join(outDir, 'phone-result.png'), await phone.screenshot());
  await phone.tap(buttonByText('Close'));
  await phone.waitFor(`!${bodyHas('Your score')}`, { what: 'result dismissed' });

  const resources = await phone.evaluate(`performance.getEntriesByType('resource')
    .map((entry) => ({ name: entry.name.split('/').pop().split('?')[0], bytes: entry.encodedBodySize }))`);
  const fonts = resources.filter((entry) => /\.(otf|ttf|woff2?)$/.test(entry.name));
  check('phone never downloads the 16 MB CJK web font', fonts.length === 0, {
    fonts,
    totalBytes: resources.reduce((sum, entry) => sum + entry.bytes, 0),
  });
}

async function leaveFlow({ relay, phone }) {
  await phone.tap(buttonByText('Leave'));
  await phone.waitFor(bodyHas('Join as'), { what: 'join card after leave' });
  check('leave frees the slot with bye', relay.framesFrom('mic', 'bye').length === 1 && relay.slot(SLOT) === null);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
