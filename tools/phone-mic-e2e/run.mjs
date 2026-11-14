// FireSong phone e2e (WP5, phone app v2): the phone /m page in headless Chrome
// with iPhone-sized mobile emulation and a fake microphone, joining through a
// mock /rtc relay (with the §13 party channel and a fake song book) and
// streaming to a mock TV page in the same browser. A second phone runs with
// Android emulation, and a third Chrome without UDP checks the can't-connect
// guidance.
//
// Usage: node tools/phone-mic-e2e/run.mjs   (after `pnpm --dir client build`)
// Env:   CHROME (default /usr/bin/google-chrome), FIRESONG_E2E_OUT (report dir),
//        FIRESONG_SHOTS_DIR (phone screenshots; default: the report dir)
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
const shotsDir = process.env.FIRESONG_SHOTS_DIR ?? outDir;
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const IPHONE = { width: 390, height: 844, deviceScaleFactor: 3, ua: IPHONE_UA, platform: 'iPhone' };
const ANDROID = { width: 412, height: 915, deviceScaleFactor: 2.625, ua: ANDROID_UA, platform: 'Linux armv8l' };
const SLOT = 2;
const PARTNER_SLOT = 3;
const OFFLINE_SLOT = 4;
/** PHONE-V2.md: 800 KB as Vite counts it (1 kB = 1000 bytes), uncompressed. */
const BUNDLE_BUDGET_BYTES = 800_000;
const UNREACHABLE_WITHIN_MS = 25_000;
/**
 * No UDP, so ICE cannot connect. Chrome 156 reads `--webrtc-ip-handling-policy`;
 * the `--force-` spelling of PHONE-V2.md is kept for older builds.
 */
const NO_UDP_FLAGS = [
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
];
/** Party requests: a burst of 6, then one every 3 s (PROTOCOL.md §13.10). */
const PARTY_REQUEST_REFILL_MS = 3_000;
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

const visible = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => el.checkVisibility())`;
const buttonByText = (text) => `${visible('button')}.find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
const tabByText = (text) => `${visible('[role=tab]')}.find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
const testId = (id) => `document.querySelector('[data-testid=${JSON.stringify(id)}]')`;
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

/** Emulates a phone in a page and records the JS/CSS bytes, sockets and requests it makes. */
async function preparePhone(chrome, device, { dark = false, reducedMotion = false } = {}) {
  const page = await chrome.newPage({ isolated: true });
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: device.width,
    height: device.height,
    deviceScaleFactor: device.deviceScaleFactor,
    mobile: true,
  });
  await page.send('Emulation.setUserAgentOverride', { userAgent: device.ua, platform: device.platform });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' },
      { name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' },
    ],
  });
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const devices = navigator.mediaDevices;
      const original = devices.getUserMedia.bind(devices);
      window.__e2e = { gum: 0, streams: [], constraints: [], sawUnreachable: false };
      devices.getUserMedia = async (constraints) => {
        window.__e2e.constraints.push(constraints);
        const stream = await original(constraints);
        window.__e2e.gum += 1;
        window.__e2e.streams.push(stream);
        return stream;
      };
      new MutationObserver(() => {
        if (document.querySelector('[data-testid=voice-unreachable]')) window.__e2e.sawUnreachable = true;
      }).observe(document, { childList: true, subtree: true });
    })();`,
  });
  page.network = { responses: new Map(), bytes: new Map(), sockets: [], requests: [] };
  chrome.on('event', (message) => {
    if (message.sessionId !== page.sessionId) return;
    const { method, params } = message;
    if (method === 'Network.requestWillBeSent') page.network.requests.push(params.request.url);
    if (method === 'Network.responseReceived') page.network.responses.set(params.requestId, { url: params.response.url, type: params.type });
    if (method === 'Network.dataReceived') {
      page.network.bytes.set(params.requestId, (page.network.bytes.get(params.requestId) ?? 0) + params.dataLength);
    }
    if (method === 'Network.webSocketCreated') page.network.sockets.push(params.url);
  });
  await page.send('Network.enable');
  return page;
}

/** Uncompressed JS and CSS bytes the page loaded, from the CDP network log. */
const bundleBytes = (page) => {
  const files = [];
  for (const [requestId, response] of page.network.responses) {
    if (response.type === 'Script' || response.type === 'Stylesheet') {
      files.push({ name: response.url.split('/').pop(), bytes: page.network.bytes.get(requestId) ?? 0 });
    }
  }
  return { total: files.reduce((sum, file) => sum + file.bytes, 0), files };
};

async function shot(page, name) {
  await writeFile(path.join(shotsDir, `${name}.png`), await page.screenshot());
}

async function main() {
  await access(path.join(distDir, 'index.html')).catch(() => {
    throw new Error(`no client build at ${distDir}; run pnpm --dir client build first`);
  });
  await mkdir(outDir, { recursive: true });
  await mkdir(shotsDir, { recursive: true });
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
  const chromeArgs = (userDataDir) => [
    '--headless=new',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--lang=en-US',
    '--mute-audio',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${tone}`,
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
  ];
  const chrome = Chrome.launch(chromePath, chromeArgs(profile), chromeLog);

  let tv;
  let phone;
  let partner;
  let offline;
  let offlineChrome;
  try {
    tv = await chrome.newPage();
    await tv.navigate(`${relay.tvOrigin}/tv-mock.html`);
    await tv.waitFor('window.tvMock?.ready === true', { what: 'TV mock ready' });

    phone = await preparePhone(chrome, IPHONE, { dark: true });
    await prejoinSongBook({ relay, phone });
    await joinFlow({ relay, tv, phone });
    await meterAndAudio({ relay, tv, phone });
    await trackRecovery({ relay, tv, phone });
    await muteFlow({ relay, tv, phone });
    await socketKill({ relay, tv, phone });
    await tvReload({ relay, tv, phone });
    await tabSwitching({ relay, tv, phone });

    partner = await preparePhone(chrome, ANDROID, { reducedMotion: true });
    await partnerJoins({ relay, tv, partner });
    await reserveFlow({ relay, phone, partner });
    await remoteFlow({ relay, tv, phone, partner });
    await mixFlow({ relay, phone });
    await tuneFlow({ relay, phone });
    await funButtons({ relay, phone });
    await songResult({ relay, phone, partner });

    offlineChrome = Chrome.launch(
      chromePath,
      [...chromeArgs(path.join(outDir, 'chrome-profile-offline')), ...NO_UDP_FLAGS],
      chromeLog,
    );
    offline = await preparePhone(offlineChrome, IPHONE);
    await cantConnect({ relay, phone, partner, offline });
    await noAck({ relay, phone });
    await expiredLink({ relay, phone });
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
          partnerConsole: partner?.console ?? [],
          offlineConsole: offline?.console ?? [],
          tvConsole: tv?.console ?? [],
          phoneHttp: relay.httpLog,
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
    await offlineChrome?.close();
    await relay.close();
    chromeLog.end();
    await rm(profile, { recursive: true, force: true });
    await rm(path.join(outDir, 'chrome-profile-offline'), { recursive: true, force: true });
  }

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Report: ${outDir}/report.json`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

async function prejoinSongBook({ relay, phone }) {
  await phone.navigate(`${relay.phoneOrigin}/m?t=${relay.token}&slot=${SLOT}`);
  await phone.waitFor(bodyHas('Join as Fuchsia mic'), { what: 'join button' });
  await sleep(500);

  const bundle = bundleBytes(phone);
  const biggest = await largestScript();
  check('the JS and CSS that /m loads stay within 800 KB (CDP network log)', bundle.total > 0 && bundle.total <= BUNDLE_BUDGET_BYTES, {
    bytes: bundle.total,
    budget: BUNDLE_BUDGET_BYTES,
    files: bundle.files,
  });
  check('phone never loads the main client chunk', !bundle.files.some((file) => file.name === biggest.name), {
    fullClientChunk: `${biggest.name} (${biggest.size} bytes, not loaded)`,
  });
  timings.bundleBytes = bundle.total;
  await shot(phone, '01-join');

  await phone.tap(tabByText('Songs'));
  await phone.waitFor(`${bodyHas('Ready to sing')} && document.querySelectorAll('#phone-panel-songs li').length >= 25`, {
    what: 'song book first page',
  });
  const firstPage = await phone.evaluate(`document.querySelectorAll('#phone-panel-songs li').length`);
  await phone.evaluate(`document.querySelector('#phone-panel-songs input[type=search]').focus()`);
  await phone.send('Input.insertText', { text: 'creep 17' });
  await phone.waitFor(`${visible('#phone-panel-songs li')}.length === 1 && ${bodyHas('Radiohead')}`, { what: 'search result' });
  const searches = relay.httpLog.filter((entry) => entry.path === '/api/cmd/firesong_song_book').length;
  check('before joining, a song book search works', firstPage === 25 && searches >= 2, { firstPage, searches });

  await phone.tap(`${visible('#phone-panel-songs li button')}[0]`);
  const askJoin = await phone.waitFor(bodyHas('Join as a mic first'), { what: 'join first' });
  check('before joining, Reserve asks the guest to join first', askJoin.value && relay.framesFrom('mic', 'reserve').length === 0);
  await phone.tap(`${visible('dialog[open] button')}.find((b) => b.textContent.trim() === 'Join as a mic')`);
  await phone.waitFor(`${bodyHas('Join as Fuchsia mic')} && document.querySelector('dialog[open]') === null`, { what: 'back on the join card' });
}

async function joinFlow({ relay, phone }) {
  check('pairing token is removed from the address bar', (await phone.evaluate('location.search')) === `?slot=${SLOT}`);
  await phone.evaluate(`document.querySelector('#phone-panel-sing input').focus()`);
  await phone.send('Input.insertText', { text: 'Jim' });

  const started = performance.now();
  await phone.tap(`document.querySelector('#phone-panel-sing button[type=submit]')`);
  const live = await phone.waitFor(bodyHas('Live on the TV'), { timeoutMs: 10_000, what: 'live' });
  timings.joinToLiveMs = Math.round(performance.now() - started);
  check('tap to live on the TV in under 5 s', live.value && timings.joinToLiveMs < 5_000, {
    ms: timings.joinToLiveMs,
  });
  check('the page opens no other tab or page (no target=_blank, no /q link)', await phone.evaluate(`document.querySelector('a[target=_blank], a[href="/q"]') === null`));

  const hello = relay.framesFrom('mic', 'hello').at(-1)?.frame;
  check('hello carries micId, QR slot and name', hello?.slot === SLOT && hello?.name === 'Jim' && /^[\w-]{8,64}$/.test(hello?.micId), { hello });
  const snapshotAfterAssign = relay.framesTo('mic', 'party').length > 0;
  check('a party snapshot follows assign', snapshotAfterAssign);
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
  await shot(phone, '02-live');
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

async function tabSwitching({ relay, tv, phone }) {
  const offers = relay.framesFrom('mic', 'offer').length;
  const hellos = relay.framesFrom('mic', 'hello').length;
  const visited = [];
  for (const tab of ['Songs', 'Queue', 'Party', 'Sing', 'Songs', 'Party', 'Sing']) {
    await phone.tap(tabByText(tab));
    await phone.waitFor(`${tabByText(tab)}?.getAttribute('aria-selected') === 'true'`, { what: `${tab} tab` });
    visited.push(tab);
    await sleep(250);
  }
  const live = await tv.evaluate(`${tvSlot('connectionState')} === 'connected' && (${tvSlot('rms')} ?? 0) > ${HEARD_RMS}`);
  check('switching through all tabs while live sends no new offer and keeps the link live', live &&
    relay.framesFrom('mic', 'offer').length === offers && relay.framesFrom('mic', 'hello').length === hellos &&
    (await phone.evaluate(bodyHas('Live on the TV'))), {
    visited,
    newOffers: relay.framesFrom('mic', 'offer').length - offers,
  });
}

async function joinAs(page, origin, token, slot, name) {
  await page.navigate(`${origin}/m?t=${token}&slot=${slot}`);
  await page.waitFor(bodyHas('Join as'), { what: `join card for slot ${slot}` });
  await page.evaluate(`document.querySelector('#phone-panel-sing input').focus()`);
  await page.send('Input.insertText', { text: name });
  await page.tap(`document.querySelector('#phone-panel-sing button[type=submit]')`);
}

async function partnerJoins({ relay, tv, partner }) {
  await joinAs(partner, relay.phoneOrigin, relay.token, PARTNER_SLOT, 'Ann');
  await partner.waitFor(bodyHas('Live on the TV'), { timeoutMs: 10_000, what: 'partner live' });
  const heard = await tv.waitFor(`(window.tvMock?.slots?.[${PARTNER_SLOT}]?.rms ?? 0) > ${HEARD_RMS}`, { what: 'TV hears the partner' });
  const bundle = bundleBytes(partner);
  check('an Android-sized phone joins and goes live', heard.value && bundle.total <= BUNDLE_BUDGET_BYTES, {
    bundleBytes: bundle.total,
  });
}

const songButton = (title) =>
  `${visible('#phone-panel-songs li button')}.find((b) => b.querySelector('span span')?.textContent === ${JSON.stringify(title)})`;
const dialogButton = (text) => `${visible('dialog[open] button')}.find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
const dialogLabelled = (label) => `${visible('dialog[open] button')}.find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)})`;

async function search(page, text) {
  await page.evaluate(`document.querySelector('#phone-panel-songs input[type=search]').select()`);
  await page.send('Input.insertText', { text });
}

async function reserveFlow({ relay, phone, partner }) {
  await phone.tap(tabByText('Songs'));
  await search(phone, 'wonderwall');
  await phone.waitFor(`${visible('#phone-panel-songs li')}.length === 6 && ${bodyHas('Takes about')}`, { what: 'wonderwall results' });
  const order = await phone.evaluate(`${visible('#phone-panel-songs li')}.map((li) => li.innerText.split('\\n')[0])`);
  check('the song book lists ready songs first, then a divider with the time to get ready', order.length === 6 && (await phone.evaluate(`${visible('#phone-panel-songs h3')}.length === 1`)), { order });
  await shot(phone, '03-song-book');

  await phone.tap(songButton('Wonderwall'));
  await phone.waitFor(`${dialogButton('Reserve')} !== undefined`, { what: 'reserve sheet' });
  await phone.tap(dialogLabelled('Increase Key'));
  await phone.tap(`${visible('dialog[open] input[type=checkbox]')}[0]`);
  await phone.tap(`${visible('dialog[open] label')}.find((l) => l.textContent.includes('Ann'))`);
  await shot(phone, '04-reserve-sheet');
  await phone.tap(dialogButton('Reserve'));
  await phone.waitFor(`document.querySelector('dialog[open]') === null`, { what: 'sheet closed' });
  await sleep(300);
  const reserve = relay.framesFrom('mic', 'reserve').at(-1)?.frame;
  const ack = relay.framesTo('mic', 'ack').at(-1)?.frame;
  check('reserve with key, sing next and a duet partner', reserve?.keyOffset === 1 && reserve?.singNext === true &&
    JSON.stringify(reserve?.partners) === `[${PARTNER_SLOT}]` && reserve?.reqId === ack?.reqId && ack?.ok === true, { reserve, ack });
  const notice = await partner.waitFor(bodyHas('Jim added you to a duet: Wonderwall'), { what: 'duet notice' });
  check('the partner hears they were added to a duet', notice.value);

  await phone.tap(songButton('Wonderwall 45'));
  const waitNote = await phone.waitFor(bodyHas("It joins the line when it's ready"), { what: 'not ready note' });
  await phone.tap(dialogButton('Reserve'));
  await phone.waitFor(`document.querySelector('dialog[open]') === null`, { what: 'sheet closed' });
  const preparing = relay.party.queue.find((item) => item.title === 'Wonderwall 45');
  check('a song that is not ready can be reserved and is getting ready', waitNote.value && preparing?.prep.state === 'queued', { prep: preparing?.prep });
  relay.party.setPrep(preparing.reservationId, { state: 'analyzing', pct: 40, etaSecs: 75 });
  relay.party.hostQueue(relay.party.library[1].fileHash);

  await phone.tap(tabByText('Queue'));
  await phone.waitFor(`${bodyHas('Getting ready… 40%')} && ${bodyHas('Picked on the TV')} && ${bodyHas('Key +1')}`, { what: 'queue view' });
  const rows = await phone.evaluate(`${visible('#phone-panel-queue ol > li')}.map((li) => li.innerText.replace(/\\n+/g, ' | '))`);
  check('the queue shows singers by name, sing next, key and preparation state', rows.length === 3 && rows[0].includes('Jim') && rows[0].includes('Ann') && rows[0].includes('Sing next'), { rows });
  await shot(phone, '05-queue');

  await phone.tap(`${visible('#phone-panel-queue ol > li button')}[0]`);
  await phone.waitFor(`${dialogButton('Save changes')} !== undefined`, { what: 'edit sheet' });
  await phone.tap(dialogLabelled('Increase Key'));
  await phone.tap(dialogButton('Save changes'));
  await sleep(400);
  const edit = relay.framesFrom('mic', 'edit').at(-1)?.frame;
  check('the owner edits key and tempo of a ready reservation', edit?.keyOffset === 2 && edit?.tempo === undefined, { edit });

  await partner.tap(tabByText('Queue'));
  await partner.waitFor(`${visible('#phone-panel-queue ol > li button')}.length === 1`, { what: 'partner edit button' });
  await partner.tap(`${visible('#phone-panel-queue ol > li button')}[0]`);
  const leave = await partner.waitFor(`${dialogButton('Leave this duet')} !== undefined && ${bodyHas('Jim picked this duet.')}`, { what: 'partner sheet' });
  check('a partner gets Leave, not the owner controls', leave.value && !(await partner.evaluate(`${dialogButton('Save changes')} !== undefined`)));
  await partner.tap(dialogButton('Close'));
}

async function litCount(page) {
  return page.evaluate(`Number(${testId('lyric-card')}?.dataset.lit ?? -1)`);
}

async function remoteFlow({ relay, phone, partner }) {
  await phone.tap(tabByText('Sing'));
  await partner.tap(tabByText('Sing'));
  relay.party.setStage({ state: 'lobby', singers: [], countdownSecs: 15 });
  const upNext = await phone.waitFor(`${bodyHas('You\'re up next: Wonderwall')} && ${bodyHas("You're up in")}`, { what: 'up next card' });
  check('the next singer sees the countdown and Start now', upNext.value && (await phone.evaluate(`${buttonByText('Start now')} !== undefined`)));
  await phone.tap(buttonByText('Start now'));
  await phone.waitFor(`${bodyHas('Your song')} && ${buttonByText('Pause')} !== undefined`, { what: 'remote' });
  const start = relay.framesTo('tv', 'control').at(-1)?.frame;
  check('Start now reaches the TV as control start-now', start?.action === 'start-now' && start?.slot === SLOT, { start });
  check('the singer sees the song key they reserved', await phone.evaluate(`${visible('output')}.some((o) => o.textContent === '+2')`));

  relay.party.lyric({ line: 'Today is gonna be the day', next: "That they're gonna throw it back to you", lineMs: 4_000, elapsedMs: 0, paused: false });
  await phone.waitFor(`${testId('lyric-card')} !== null`, { what: 'lyric card' });
  const early = await litCount(phone);
  await sleep(1_000);
  const later = await litCount(phone);
  const chars = await phone.evaluate(`Number(${testId('lyric-card')}.dataset.chars)`);
  const still = await partner.waitFor(`Number(${testId('lyric-card')}?.dataset.lit ?? -1) === Number(${testId('lyric-card')}?.dataset.chars)`, { what: 'partner lyric' });
  relay.party.lyric({ line: 'Today is gonna be the day', next: "That they're gonna throw it back to you", lineMs: 4_000, elapsedMs: 2_000, paused: true });
  await sleep(300);
  const pausedA = await litCount(phone);
  await sleep(600);
  const pausedB = await litCount(phone);
  check('the lyric wipe follows the frames and freezes while paused', later > early && pausedA === pausedB && Math.abs(pausedA - chars / 2) <= 1 && still.value, {
    early, later, chars, paused: pausedA,
  });
  relay.party.lyric({ line: 'Today is gonna be the day', next: "That they're gonna throw it back to you", lineMs: 4_000, elapsedMs: 1_200, paused: false });

  await phone.tap(buttonByText('Pause'));
  await phone.waitFor(`${buttonByText('Resume')} !== undefined`, { what: 'resume button' });
  await phone.tap(buttonByText('Resume'));
  await phone.waitFor(`${buttonByText('Pause')} !== undefined`, { what: 'pause button again' });
  const controls = relay.framesTo('tv', 'control').map((entry) => entry.frame.action);
  check('the singer pauses and resumes their song on the TV', controls.slice(-2).join() === 'pause,resume', { controls });

  relay.party.setStage({ ...relay.party.stage, singers: [PARTNER_SLOT] });
  await phone.waitFor(`${buttonByText('Pause')} === undefined && ${testId('lyric-card')} === null`, { what: 'remote hidden for a non-singer' });
  check('a phone that does not sing the song gets no remote', await partner.evaluate(`${buttonByText('Pause')} !== undefined`));
  relay.party.setStage({ ...relay.party.stage, singers: [SLOT, PARTNER_SLOT] });
  await phone.waitFor(`${buttonByText('Pause')} !== undefined`, { what: 'remote back' });
  relay.party.lyric({ line: 'Today is gonna be the day', next: "That they're gonna throw it back to you", lineMs: 4_000, elapsedMs: 1_200, paused: false });
  await phone.waitFor(`${testId('lyric-card')} !== null`, { what: 'lyric card again' });
  await sleep(500);
  await shot(phone, '06-lyric-line');

  await phone.tap(`${visible('button')}.find((b) => b.getAttribute('aria-label') === 'Increase Key')`);
  await phone.tap(buttonByText('Restart in this key'));
  await phone.waitFor(bodyHas('Restart in this key?'), { what: 'restart confirm' });
  await phone.tap(dialogButton('Restart'));
  const cooldown = await phone.waitFor(bodyHas('You can change it again in'), { what: 'shift cooldown' });
  const shift = relay.framesTo('tv', 'shift-current').at(-1)?.frame;
  check('a key change restarts the song through shift-current, then cools down', cooldown.value && shift?.keyOffset === 3 && shift?.tempo === 1, { shift });
  await phone.evaluate(`document.querySelector('#phone-panel-sing').scrollTo(0, 0)`);
  await shot(phone, '07-remote');

  await sleep(PARTY_REQUEST_REFILL_MS + 500);
  await phone.tap(buttonByText('Stop'));
  await phone.waitFor(bodyHas('End the song?'), { what: 'stop confirm' });
  await phone.tap(dialogButton('End song'));
  await phone.waitFor(`${buttonByText('Pause')} === undefined && ${testId('lyric-card')} === null`, { what: 'back in the lobby' });
  check('Stop asks first, ends the song and hides the lyric card', relay.framesTo('tv', 'control').at(-1)?.frame.action === 'stop' && relay.party.stage.state === 'lobby');
}

async function pressKey(page, key, times) {
  const code = { ArrowRight: 39, ArrowLeft: 37 }[key];
  for (let index = 0; index < times; index += 1) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
  }
}

async function mixFlow({ relay, phone }) {
  const slider = (label) => `[...document.querySelectorAll('input[type=range]')].find((input) => input.labels[0]?.textContent === ${JSON.stringify(label)})`;
  await phone.evaluate(`${slider('My volume')}.focus()`);
  await pressKey(phone, 'ArrowRight', 2);
  await phone.evaluate(`${slider('My echo')}.focus()`);
  await pressKey(phone, 'ArrowLeft', 4);
  await sleep(1_500);
  const mixes = relay.framesFrom('mic', 'mix').map((entry) => entry.frame);
  const tvMix = relay.framesTo('tv', 'mix').at(-1)?.frame;
  const shown = await phone.evaluate(`[${slider('My volume')}.value, ${slider('My echo')}.value]`);
  check('My volume and My echo reach the TV as mix, at most 5 a second', tvMix?.volumePct === 110 && tvMix?.echoPct === 80 &&
    mixes.length <= 6 && shown.join() === '110,80', { mixes, tvMix, shown });
}

async function tuneFlow({ relay, phone }) {
  await phone.tap(buttonByText('Tune my mic'));
  await phone.waitFor(bodyHas('Listening for the beep'), { what: 'listening' });
  const tuned = await phone.waitFor(bodyHas('Tuned: 212 ms'), { what: 'tuned' });
  const calibrate = relay.framesTo('tv', 'calibrate').at(-1)?.frame;
  check('Tune my mic runs the TV calibration for this slot', tuned.value && calibrate?.slot === SLOT &&
    (await phone.evaluate(`${buttonByText('Tune my mic')}.disabled`)), { calibrate });
  await phone.evaluate(`${buttonByText('Tune my mic')}.scrollIntoView({ block: 'center' })`);
  await shot(phone, '08-tune-my-mic');
}

async function funButtons({ relay, phone }) {
  await phone.tap(tabByText('Party'));
  const applause = `${visible('button[data-sound=applause]')}[0]`;
  await phone.waitFor(`${applause} !== undefined && !${applause}.disabled`, { what: 'fx buttons' });
  await shot(phone, '09-fun-buttons');
  const before = relay.framesFrom('mic', 'fx').length;
  for (let index = 0; index < 5; index += 1) {
    await phone.tap(applause);
  }
  await sleep(200);
  const sent = relay.framesFrom('mic', 'fx').length - before;
  const cooling = await phone.waitFor(`${bodyHas('More in')} && ${testId('fx-tokens')}.dataset.tokens === '0'`, { what: 'fx cooldown' });
  await shot(phone, '09b-fun-buttons-cooldown');
  await sleep(2_100);
  await phone.tap(`${visible('button[data-sound=cheer]')}[0]`);
  await sleep(300);
  const fx = relay.framesTo('tv', 'fx').map((entry) => entry.frame.sound);
  check('five quick taps play three sounds, then one more after 2 s', sent === 3 && cooling.value && fx.length === 4 && fx.at(-1) === 'cheer', { sent, fx });
}

async function songResult({ relay, phone, partner }) {
  const now = Math.floor(Date.now() / 1_000);
  relay.party.setScores([
    { slot: 1, color: 'rose', name: 'Mina', title: 'The Final Countdown', displayScore: 100, rawScore: 995, tier: 'perfect', atSecs: now - 900 },
    { slot: 4, color: 'emerald', name: 'Sam', title: 'Creep', displayScore: 88, rawScore: 760, tier: 'great', atSecs: now - 600 },
    { slot: 1, color: 'rose', name: 'Mina', title: 'Song 2', displayScore: 74, rawScore: 610, tier: 'good', atSecs: now - 300 },
  ]);
  relay.party.setStage({ state: 'reveal', title: 'Wonderwall', artist: 'Oasis', singers: [SLOT, PARTNER_SLOT] });
  await sleep(200);
  relay.sendSongResult({
    title: 'Wonderwall',
    results: [
      { slot: SLOT, displayScore: 96, rawScore: 812, tier: 'excellent', rank: 1 },
      { slot: PARTNER_SLOT, displayScore: 71, rawScore: 540, tier: 'good', rank: 2 },
    ],
  });
  const shown = await phone.waitFor(`${testId('score-card')}?.open === true && ${bodyHas('96')} && ${bodyHas('훌륭해요!')} && ${bodyHas('#2 tonight')}`, {
    what: 'score card',
  });
  await phone.waitFor(`[...${testId('score-card')}.querySelectorAll('img')].every((img) => img.complete && img.naturalWidth > 0)`, {
    what: 'mascot pose and wordmark loaded',
  });
  const card = await phone.evaluate(`(() => {
    const el = ${testId('score-card')};
    const box = el.querySelector('article').getBoundingClientRect();
    const close = [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Close').getBoundingClientRect();
    return { html: el.outerHTML, text: el.innerText, cardBottom: box.bottom, closeTop: close.top, closeBottom: close.bottom, height: innerHeight };
  })()`);
  const leaks = [/[?&]t=/, /\/m\?/, new RegExp(relay.token)].filter((pattern) => pattern.test(card.html)).map(String);
  check('the score card shows the score, tier, song, artist, name and rank', shown.value && ['Excellent!', 'Wonderwall', 'Oasis', 'Jim', '#1 of 2'].every((text) => card.text.includes(text)));
  check('the score card fits 390x844 with Close below it and leaks no link or token', leaks.length === 0 && card.closeTop >= card.cardBottom && card.closeBottom <= card.height, {
    leaks, cardBottom: card.cardBottom, closeTop: card.closeTop, closeBottom: card.closeBottom, height: card.height,
  });
  await shot(phone, '10-score-card');
  await partner.waitFor(`${testId('score-card')}?.open === true && ${bodyHas('71')}`, { what: 'partner score card' });
  await partner.tap(`[...${testId('score-card')}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Close')`);

  await phone.tap(`[...${testId('score-card')}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Close')`);
  await phone.waitFor(`${testId('score-card')} === null`, { what: 'score card closed' });
  relay.party.setStage({ state: 'lobby', singers: [] });
  const board = await phone.waitFor(`${testId('night-board')}?.querySelectorAll('li').length === 5 && ${bodyHas('Your last song is #2 tonight.')}`, {
    what: "tonight's best",
  });
  const order = await phone.evaluate(`[...${testId('night-board')}.querySelectorAll('li')].map((li) => li.innerText.split('\\n')[1])`);
  check("tonight's best lists the board best first, with this phone's rank", board.value && order.join() === '100,96,88,74,71', { order });
  await phone.evaluate(`document.getElementById('phone-best-title').scrollIntoView({ block: 'start' })`);
  await shot(phone, '11-tonights-best');

  const resources = await phone.evaluate(`performance.getEntriesByType('resource')
    .map((entry) => ({ name: entry.name.split('/').pop().split('?')[0], bytes: entry.encodedBodySize }))`);
  const fonts = resources.filter((entry) => /\.(otf|ttf|woff2?)$/.test(entry.name));
  check('phone never downloads the 16 MB CJK web font', fonts.length === 0, { fonts });
  check('phone never opens /ws (CDP network log)', ![...phone.network.sockets, ...phone.network.requests].some((url) => new URL(url).pathname === '/ws'), {
    sockets: phone.network.sockets,
  });
}

async function cantConnect({ relay, phone, partner, offline }) {
  const started = performance.now();
  await joinAs(offline, relay.phoneOrigin, relay.token, OFFLINE_SLOT, 'Pat');
  const shown = await offline.waitFor(`${testId('voice-unreachable')} !== null`, { timeoutMs: UNREACHABLE_WITHIN_MS + 5_000, what: 'unreachable guidance' });
  timings.unreachableMs = Math.round(performance.now() - started);
  const text = await offline.evaluate(`${testId('voice-unreachable')}.innerText`);
  const diag = relay.framesFrom('mic', 'diag').map((entry) => entry.frame).find((frame) => frame.data?.reason === 'unreachable');
  const diagJson = JSON.stringify(diag ?? {});
  check('a phone whose voice cannot reach the TV shows the Wi-Fi guidance within 25 s', shown.value && timings.unreachableMs <= UNREACHABLE_WITHIN_MS &&
    text.includes('Join the home Wi-Fi') && text.includes('Try again'), { ms: timings.unreachableMs, text });
  check('diag reports unreachable with candidate counts and no addresses', diag?.data?.reach?.unreachable === true &&
    !/a=candidate|\d+\.\d+\.\d+\.\d+/.test(diagJson.replace(/"ua":"[^"]*"/, '')), { reach: diag?.data?.reach });
  await shot(offline, '12-cant-connect');

  await offline.tap(tabByText('Songs'));
  const songs = await offline.waitFor(`${visible('#phone-panel-songs li')}.length >= 25`, { what: 'song book without voice' });
  check('without voice the song book still works over the socket and HTTP', songs.value);
  check('phones on the home network never show the guidance', !(await phone.evaluate('window.__e2e.sawUnreachable')) &&
    !(await partner.evaluate('window.__e2e.sawUnreachable')));
}

async function noAck({ relay, phone }) {
  relay.party.options.dropAcks = true;
  await phone.tap(tabByText('Songs'));
  await search(phone, 'golden hour highway');
  await phone.waitFor(`${songButton('Golden Hour Highway')} !== undefined`, { what: 'golden hour' });
  await phone.tap(songButton('Golden Hour Highway'));
  await phone.waitFor(`${dialogButton('Reserve')} !== undefined`, { what: 'reserve sheet' });
  const started = performance.now();
  await phone.tap(dialogButton('Reserve'));
  await phone.waitFor(bodyHas("That didn't reach the TV. Try again."), { timeoutMs: 8_000, what: 'no-ack message' });
  const ms = Math.round(performance.now() - started);
  relay.party.options.dropAcks = false;
  check('a request with no ack in 5 s says it did not reach the TV', ms >= 4_900 && ms < 7_000, { ms });
}

async function expiredLink({ relay, phone }) {
  relay.rotateToken();
  await phone.tap(tabByText('Songs'));
  await search(phone, 'blur');
  const expired = await phone.waitFor(bodyHas('This link has expired. Scan the code on the TV again.'), { what: 'expired message' });
  check('a rotated token turns the song book into "scan again"', expired.value);
}

async function leaveFlow({ relay, phone }) {
  await phone.tap(tabByText('Sing'));
  await phone.tap(buttonByText('Leave'));
  await phone.waitFor(bodyHas('Join as'), { what: 'join card after leave' });
  check('leave frees the slot with bye', relay.framesFrom('mic', 'bye').length === 1 && relay.slot(SLOT) === null);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
