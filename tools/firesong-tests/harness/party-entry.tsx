// Page for party-harness.test.ts: the real fun-sound synth, MicRack and
// voice engine, a phone calibration against a fake phone that hears the TV
// (tools/fakephone/loopback.js), and the party lobby rendered from fixtures.
import { createRoot } from 'react-dom/client';

import { createFxSynth, FX_DURATION_SEC } from '@/audio/fx-synth';
import { MicRack } from '@/audio/mic-rack';
import { getVoiceEngine } from '@/audio/voice-engine';
import { DEFAULT_ECHO_MIX } from '@/audio/voice-params';
import { dispatchMicFrame } from '@/bridge/microphone-samples';
import { withRemoteMics } from '@/bridge/microphone.phone';
import { webMicrophoneAdapter } from '@/bridge/microphone.web';
import { RemoteMics, type TvInbound, type TvOutbound } from '@/bridge/remote-mics';
import { measureMicLatencySec } from '@/features/microphone/lib/latency-test';
import { PartyLobby } from '@/features/party-lobby/components/party-lobby';
import { PartyOverlays } from '@/features/party-lobby/components/party-overlays';
import type { LobbyStatus } from '@/features/party-lobby/conductor';
import { lobbyModel } from '@/features/party-lobby/lobby-model';
import { partyTv } from '@/features/party-lobby/party-store';
import { PhoneCalibrator } from '@/features/remote-mic/phone-calibration';
import type { FxSound, MicLink, PartySnapshot } from '@/features/remote-mic/protocol';

import { loopbackPhone, silentPhone } from '../../fakephone/loopback.js';

const RECORDER_SRC = `
class PartyRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const frames = input[0].length;
      const mono = new Float32Array(frames);
      for (let c = 0; c < input.length; c++) {
        for (let i = 0; i < frames; i++) mono[i] += input[c][i] / input.length;
      }
      this.port.postMessage(mono);
    }
    return true;
  }
}
registerProcessor('party-recorder', PartyRecorder);
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => boolean, ms = 5000) => {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > ms) {
      throw new Error('timed out');
    }
    await sleep(20);
  }
};

let recording: Float32Array[] | null = null;

const startRecorder = async () => {
  const engine = getVoiceEngine();
  await engine.ready;
  await engine.resume();
  const url = URL.createObjectURL(new Blob([RECORDER_SRC], { type: 'application/javascript' }));
  await engine.context.audioWorklet.addModule(url);
  const recorder = new AudioWorkletNode(engine.context, 'party-recorder', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  });
  recorder.port.onmessage = (event: MessageEvent<Float32Array>) => recording?.push(event.data);
  engine.output.connect(recorder);
};

const record = async (ms: number, during: () => void): Promise<Float32Array> => {
  recording = [];
  during();
  await sleep(ms);
  const chunks = recording;
  recording = null;
  const out = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

/** Peak, RMS over the audible part, audible length (above -50 dBFS) and NaN count. */
const measure = (samples: Float32Array, sampleRate: number) => {
  const floor = 10 ** (-50 / 20);
  let first = -1;
  let last = -1;
  let peak = 0;
  let nan = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index];
    if (Number.isNaN(value)) {
      nan += 1;
      continue;
    }
    const level = Math.abs(value);
    peak = Math.max(peak, level);
    if (level > floor) {
      first = first < 0 ? index : first;
      last = index;
    }
  }
  let sum = 0;
  for (let index = Math.max(0, first); index <= last; index += 1) {
    sum += samples[index] * samples[index];
  }
  const rms = last > first ? Math.sqrt(sum / (last - first + 1)) : 0;
  const db = (value: number) => (value > 0 ? 20 * Math.log10(value) : -Infinity);
  return {
    peakDb: db(peak),
    rmsDb: db(rms),
    lengthSec: last > first ? (last - first) / sampleRate : 0,
    nan,
  };
};

const renderFx = async (sound: FxSound) => {
  const engine = getVoiceEngine();
  const synth = createFxSynth({ context: engine.context, destination: engine.output });
  const samples = await record((FX_DURATION_SEC[sound] + 0.8) * 1000, () => synth.play(sound));
  return { ...measure(samples, engine.context.sampleRate), expectedSec: FX_DURATION_SEC[sound] };
};

const sixAtOnce = async () => {
  const engine = getVoiceEngine();
  const synth = createFxSynth({ context: engine.context, destination: engine.output });
  const sounds: FxSound[] = ['applause', 'tambourine', 'cheer', 'air-horn', 'cheer', 'applause'];
  const accepted = sounds.map((sound) => synth.play(sound));
  const playing = synth.playing();
  await sleep(3500);
  return { accepted, playing, after: synth.playing() };
};

const MIC = 'fakeTune1234';

type FakePhone = { stream: MediaStream; stop(): void };

/**
 * Phone calibrations on the voice engine with a fake phone as slot 3: one
 * joined phone, calibrated once per entry of `delaysMs`. Each run is a fresh
 * fake phone that hears the TV that much later (a re-offer, as a phone that
 * reconnects), or hears nothing. Returns the frames each run sent.
 */
const calibrate = async (kind: 'loopback' | 'silent', delaysMs: number[]) => {
  const engine = getVoiceEngine();
  const rack = await MicRack.create(engine);
  let phone: FakePhone | null = null;
  const sent: TvOutbound[] = [];
  let push: ((frame: TvInbound) => void) | null = null;
  const mics = new RemoteMics({
    rack: async () => rack,
    connect: (onFrame, onOpen) => {
      push = onFrame;
      onOpen(true);
      return { send: (frame) => (sent.push(frame), true), stop: () => undefined };
    },
    createPeer: (init) => ({
      micId: init.micId,
      acceptOffer: async () => {
        if (phone !== null) {
          init.events.onStream(phone.stream);
        }
      },
      addIce: () => undefined,
      close: () => undefined,
    }),
    dispatchFrame: dispatchMicFrame,
    devicesChanged: () => undefined,
    label: (slot) => `Slot ${slot.slot}`,
    monitorAlways: () => false,
    echoMix: () => DEFAULT_ECHO_MIX,
  });
  const stop = mics.start();
  await until(() => push !== null);
  const deliver = (frame: TvInbound) => push?.(frame);
  deliver({ type: 'ready', v: 1, iceServers: [] });
  deliver({
    type: 'roster',
    slots: [1, 2, 3, 4].map((slot) =>
      slot === 3
        ? { slot, color: 'amber', state: 'connected', micId: MIC, name: 'Jim', muted: false }
        : { slot, color: 'rose', state: 'empty', muted: false },
    ),
  });
  const adapter = withRemoteMics(webMicrophoneAdapter, mics, { tvProfile: () => true });
  const calibrator = new PhoneCalibrator({
    measure: (deviceId) =>
      measureMicLatencySec(deviceId, adapter, {
        context: engine.context,
        destination: engine.output,
      }),
    send: (frame) => (sent.push(frame), true),
    reportLatency: (micId, latencyMs, method) => mics.reportLatency(micId, latencyMs, method),
    hasAudio: (slot) => mics.slotStatus(slot)?.attached === true,
    idle: () => true,
    setTuning: () => undefined,
    settle: async () => undefined,
  });
  const runs: TvOutbound[][] = [];
  for (const delayMs of delaysMs) {
    phone?.stop();
    phone =
      kind === 'loopback'
        ? loopbackPhone(engine.context, engine.output, delayMs)
        : silentPhone(engine.context);
    deliver({ type: 'offer', slot: 3, micId: MIC, sdp: 'fake', restart: false });
    await until(() => mics.slotStatus(3)?.attached === true);
    await sleep(500);
    const from = sent.length;
    calibrator.run(3, MIC);
    await until(() => !calibrator.isRunning(), 10_000);
    runs.push(
      sent
        .slice(from)
        .filter((frame) => frame.type === 'calibration' || frame.type === 'latency'),
    );
  }
  stop();
  await sleep(50);
  phone?.stop();
  return { runs, contextState: engine.context.state };
};

/** A QR-like pattern for the screenshot (three finder squares, fixed noise); not scannable. */
const fixtureQr = (seed: number): string => {
  const size = 25;
  const corners = [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ];
  const finder = (x: number, y: number): boolean | null => {
    for (const [cx, cy] of corners) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx >= -1 && dy >= -1 && dx <= 7 && dy <= 7) {
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        return ring !== 2 && ring !== 4;
      }
    }
    return null;
  };
  const cells: string[] = [];
  let state = seed;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      if (finder(x, y) ?? state / 2 ** 32 > 0.5) {
        cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${size + 4} ${size + 4}"><rect x="-2" y="-2" width="${size + 4}" height="${size + 4}" fill="#fff"/><g fill="#000">${cells.join('')}</g></svg>`;
};

const LINKS: MicLink[] = (['rose', 'fuchsia', 'amber', 'emerald'] as const).map((color, index) => ({
  slot: index + 1,
  color,
  url: `https://phone.example/m?t=fixture&slot=${index + 1}`,
  qrSvg: fixtureQr(index + 7),
}));

const SNAPSHOT: PartySnapshot = {
  rev: 9,
  tvConnected: true,
  stage: { state: 'lobby', singers: [], countdownSecs: 12 },
  queue: [
    {
      reservationId: 'r4',
      entryId: '12',
      fileHash: '535b53bf0c2d4e6f8a9b1c2d3e4f5a6b',
      title: 'Wonderwall',
      artist: 'Oasis',
      durationSecs: 258.5,
      singers: [2, 1],
      keyOffset: -2,
      tempo: 1,
      singNext: false,
      shiftable: true,
      prep: { state: 'ready' },
    },
    {
      reservationId: 'r5',
      fileHash: '535b53bf0c2d4e6f8a9b1c2d3e4f5a6c',
      title: 'Creep',
      artist: 'Radiohead',
      durationSecs: 238,
      singers: [3],
      keyOffset: 0,
      tempo: 1,
      singNext: false,
      shiftable: false,
      prep: { state: 'analyzing', pct: 40, etaSecs: 75 },
    },
    {
      reservationId: 'r6',
      entryId: '13',
      fileHash: '535b53bf0c2d4e6f8a9b1c2d3e4f5a6d',
      title: 'The Final Countdown',
      artist: 'Europe',
      durationSecs: 310,
      singers: [],
      keyOffset: 0,
      tempo: 1,
      singNext: false,
      shiftable: true,
      prep: { state: 'ready' },
    },
    {
      reservationId: 'r7',
      fileHash: '535b53bf0c2d4e6f8a9b1c2d3e4f5a6e',
      title: 'Bohemian Rhapsody',
      artist: 'Queen',
      durationSecs: 355,
      singers: [1, 2, 3],
      keyOffset: 0,
      tempo: 1,
      singNext: false,
      shiftable: true,
      prep: { state: 'queued', etaSecs: 280 },
    },
    {
      reservationId: 'r8',
      fileHash: '535b53bf0c2d4e6f8a9b1c2d3e4f5a6f',
      title: 'Song 2',
      artist: 'Blur',
      durationSecs: 122,
      singers: [3],
      keyOffset: 0,
      tempo: 1,
      singNext: false,
      shiftable: true,
      prep: { state: 'waiting-gpu' },
    },
  ],
  queueTotal: 7,
  singers: [
    { slot: 1, color: 'rose', name: 'Jim', state: 'connected', volumePct: 100, echoPct: 100 },
    { slot: 2, color: 'fuchsia', name: 'Mina', state: 'connected', volumePct: 120, echoPct: 150 },
    { slot: 3, color: 'amber', name: 'Sam', state: 'reserved', volumePct: 100, echoPct: 100 },
  ],
  scores: [
    { slot: 1, color: 'rose', name: 'Jim', title: 'The Final Countdown', displayScore: 100, rawScore: 995, tier: 'perfect', atSecs: 1763100000 },
    { slot: 2, color: 'fuchsia', name: 'Mina', title: 'Dancing Queen', displayScore: 94, rawScore: 880, tier: 'excellent', atSecs: 1763100300 },
    { slot: 3, color: 'amber', name: 'Sam', title: 'Creep', displayScore: 87, rawScore: 760, tier: 'great', atSecs: 1763100600 },
    { slot: 2, color: 'fuchsia', name: 'Mina', title: 'Wonderwall', displayScore: 76, rawScore: 610, tier: 'good', atSecs: 1763100900 },
    { slot: 1, color: 'rose', name: 'Jim', title: 'Song 2', displayScore: 58, rawScore: 420, tier: 'retry', atSecs: 1763101200 },
  ],
};

const STATUS: LobbyStatus = {
  kind: 'countdown',
  entry: { id: '12', title: 'Wonderwall', artist: 'Oasis' },
  singers: [2, 1],
  secondsLeft: 12,
};

const renderLobby = (withFx: boolean) => {
  const root = document.getElementById('root');
  if (root === null) {
    return;
  }
  partyTv.setSnapshot(SNAPSHOT);
  if (withFx) {
    partyTv.flash(2, 'air-horn');
    partyTv.flash(1, 'applause');
  }
  createRoot(root).render(
    <>
      <PartyLobby
        model={lobbyModel({ snapshot: SNAPSHOT, entries: [], links: LINKS, devices: [] })}
        status={STATUS}
        connected
        linksError={false}
        onStartNow={() => undefined}
        onPickSong={() => undefined}
        onClearBest={() => undefined}
      />
      <PartyOverlays />
    </>,
  );
};

const party = { ready: false, renderFx, sixAtOnce, calibrate, renderLobby };

declare global {
  interface Window {
    party: typeof party;
  }
}

window.party = party;

if (new URLSearchParams(window.location.search).has('lobby')) {
  renderLobby(new URLSearchParams(window.location.search).has('fx'));
  party.ready = true;
} else {
  startRecorder()
    .then(() => {
      party.ready = true;
      return undefined;
    })
    .catch((error: unknown) => {
      Object.assign(window, { partyError: String(error) });
    });
}
