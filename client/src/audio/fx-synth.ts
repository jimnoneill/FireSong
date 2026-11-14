import type { FxSound } from '@/features/remote-mic/protocol';

import { dbToGain } from './voice-params';

/**
 * The party's fun sounds (PROTOCOL.md §13.6 `fx`), synthesised with Web Audio
 * on the TV's voice engine: no sample files, nothing to license, and nothing
 * modelled on anyone's jingle. They mix into the engine output before the
 * master limiter, 8 dB under the voice bus, so they never reach a pitch tap.
 * At most four sound at once; more are dropped.
 */

export type FxOutput = { context: BaseAudioContext; destination: AudioNode };

export type FxSynth = {
  /** Starts a sound now; `false` when the voice limit is reached. */
  play(sound: FxSound): boolean;
  /** Sounds still playing. */
  playing(): number;
};

export type FxSynthOptions = {
  /** 0..1, for burst timing and colour. Seeded by default, so every TV sounds alike. */
  random?: () => number;
  maxVoices?: number;
};

export const FX_BUS_DB = -8;
export const FX_MAX_VOICES = 4;

/** How long each sound lasts, s. */
export const FX_DURATION_SEC: Readonly<Record<FxSound, number>> = {
  applause: 2.5,
  tambourine: 1.1,
  cheer: 2.2,
  'air-horn': 1.2,
};

const NOISE_SEC = 2;
const START_LEAD_SEC = 0.02;
const SILENT = 0.0001;

const APPLAUSE_BANDS = 4;
const APPLAUSE_CLAPS_PER_SEC = 20;
const APPLAUSE_LEVEL = 2.2;

const TAMBOURINE_PARTIALS_HZ = [5340, 7180, 9620] as const;
const TAMBOURINE_LEVEL = 0.9;

const CHEER_FORMANTS = [
  { fromHz: 520, peakHz: 760, toHz: 610, q: 3, gain: 2.6 },
  { fromHz: 1050, peakHz: 1750, toHz: 1300, q: 3, gain: 2.2 },
  { fromHz: 2450, peakHz: 2900, toHz: 2600, q: 4, gain: 1.4 },
] as const;
const CHEER_LEVEL = 0.56;

/** F major, each voice a little off so the chord beats like a real horn. */
const HORN_NOTES_HZ = [349.23, 440, 523.25] as const;
const HORN_DETUNE_CENTS = [-9, 6, -4] as const;
/** [start, end] of each stab, s: three short blasts and a long one. */
const HORN_STABS = [
  [0, 0.13],
  [0.19, 0.32],
  [0.38, 0.51],
  [0.6, 1.17],
] as const;
const HORN_DRIVE = 3;
const HORN_LEVEL = 0.3;

/** A small LCG; the same seed gives the same sounds. */
export const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

const makeNoise = (context: BaseAudioContext): AudioBuffer => {
  const length = Math.max(1, Math.floor(context.sampleRate * NOISE_SEC));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  const random = seededRandom(0x51f15eed);
  for (let index = 0; index < length; index++) {
    data[index] = random() * 2 - 1;
  }
  return buffer;
};

const softClipCurve = (drive: number): Float32Array<ArrayBuffer> => {
  const curve = new Float32Array(1024);
  const norm = Math.tanh(drive);
  for (let index = 0; index < curve.length; index++) {
    const x = (index / (curve.length - 1)) * 2 - 1;
    curve[index] = Math.tanh(drive * x) / norm;
  }
  return curve;
};

type Hit = { start: number; peak: number; attackSec: number; decaySec: number };

/** A short percussive hit on `param`: up in `attackSec`, exponential decay. */
const hit = (param: AudioParam, { start, peak, attackSec, decaySec }: Hit) => {
  param.setValueAtTime(SILENT, start);
  param.exponentialRampToValueAtTime(peak, start + attackSec);
  param.exponentialRampToValueAtTime(SILENT, start + attackSec + decaySec);
};

type Voice = { sources: AudioScheduledSourceNode[]; out: GainNode; end: number };

export const createFxSynth = (
  { context, destination }: FxOutput,
  { random = seededRandom(0x00f1e5a9), maxVoices = FX_MAX_VOICES }: FxSynthOptions = {},
): FxSynth => {
  const bus = context.createGain();
  bus.gain.value = dbToGain(FX_BUS_DB);
  let noise: AudioBuffer | null = null;
  let clipCurve: Float32Array<ArrayBuffer> | null = null;
  let active = 0;
  let wired = false;

  const noiseSource = (start: number, end: number): AudioBufferSourceNode => {
    noise ??= makeNoise(context);
    const source = context.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    source.start(start, random() * NOISE_SEC);
    source.stop(end);
    return source;
  };

  const voiceOut = (level: number): GainNode => {
    const out = context.createGain();
    out.gain.value = level;
    out.connect(bus);
    return out;
  };

  const applause = (start: number): Voice => {
    const end = start + FX_DURATION_SEC.applause;
    const out = voiceOut(APPLAUSE_LEVEL);
    const swell = context.createGain();
    swell.gain.setValueAtTime(SILENT, start);
    swell.gain.linearRampToValueAtTime(1, start + 0.35);
    swell.gain.setValueAtTime(1, end - 0.8);
    swell.gain.linearRampToValueAtTime(0, end);
    swell.connect(out);
    const source = noiseSource(start, end);
    const bands = Array.from({ length: APPLAUSE_BANDS }, () => {
      const filter = context.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 1.4;
      const gain = context.createGain();
      gain.gain.value = 0;
      source.connect(filter).connect(gain).connect(swell);
      return { filter, gain };
    });
    let time = start;
    let clap = 0;
    while (time < end - 0.08) {
      const { filter, gain } = bands[clap % APPLAUSE_BANDS];
      filter.frequency.setValueAtTime(2000 + random() * 4000, time);
      hit(gain.gain, {
        start: time,
        peak: 0.5 + random() * 0.5,
        attackSec: 0.002,
        decaySec: 0.03 + random() * 0.04,
      });
      time += (1 / APPLAUSE_CLAPS_PER_SEC) * (0.6 + random() * 0.8);
      clap += 1;
    }
    return { sources: [source], out, end };
  };

  const tambourine = (start: number): Voice => {
    const shakes = 8 + Math.floor(random() * 5);
    const spacing = (FX_DURATION_SEC.tambourine - 0.2) / (shakes - 1);
    const end = start + FX_DURATION_SEC.tambourine;
    const out = voiceOut(TAMBOURINE_LEVEL);
    const source = noiseSource(start, end);
    const highpass = context.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 6500;
    const jingle = context.createGain();
    jingle.gain.value = 0;
    source.connect(highpass).connect(jingle).connect(out);
    const ring = context.createGain();
    ring.gain.value = 0;
    ring.connect(out);
    const partials = TAMBOURINE_PARTIALS_HZ.map((hz) => {
      const osc = context.createOscillator();
      osc.frequency.value = hz * (1 + random() * 0.03);
      osc.connect(ring);
      osc.start(start);
      osc.stop(end);
      return osc;
    });
    for (let shake = 0; shake < shakes; shake++) {
      const time = start + shake * spacing;
      const accent = shake % 2 === 0 ? 1 : 0.65;
      hit(jingle.gain, { start: time, peak: 0.9 * accent, attackSec: 0.003, decaySec: 0.09 });
      hit(ring.gain, { start: time, peak: 0.12 * accent, attackSec: 0.003, decaySec: 0.16 });
    }
    return { sources: [source, ...partials], out, end };
  };

  const cheer = (start: number): Voice => {
    const end = start + FX_DURATION_SEC.cheer;
    const peakAt = start + 1.4;
    const out = voiceOut(CHEER_LEVEL);
    const swell = context.createGain();
    swell.gain.setValueAtTime(SILENT, start);
    swell.gain.linearRampToValueAtTime(1, peakAt);
    swell.gain.setValueAtTime(1, peakAt + 0.3);
    swell.gain.linearRampToValueAtTime(0, end);
    const band = context.createBiquadFilter();
    band.type = 'lowpass';
    band.frequency.value = 4000;
    band.connect(swell).connect(out);
    const source = noiseSource(start, end);
    for (const { fromHz, peakHz, toHz, q, gain: level } of CHEER_FORMANTS) {
      const formant = context.createBiquadFilter();
      formant.type = 'bandpass';
      formant.Q.value = q;
      const wobble = 1 + (random() - 0.5) * 0.1;
      formant.frequency.setValueAtTime(fromHz * wobble, start);
      formant.frequency.linearRampToValueAtTime(peakHz * wobble, peakAt);
      formant.frequency.linearRampToValueAtTime(toHz * wobble, end);
      const gain = context.createGain();
      gain.gain.value = level;
      source.connect(formant).connect(gain).connect(band);
    }
    return { sources: [source], out, end };
  };

  const airHorn = (start: number): Voice => {
    const end = start + FX_DURATION_SEC['air-horn'];
    const out = voiceOut(HORN_LEVEL);
    clipCurve ??= softClipCurve(HORN_DRIVE);
    const shaper = context.createWaveShaper();
    shaper.curve = clipCurve;
    shaper.oversample = '2x';
    const tone = context.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3500;
    shaper.connect(tone).connect(out);
    const stab = context.createGain();
    stab.gain.value = 0;
    stab.connect(shaper);
    for (const [from, to] of HORN_STABS) {
      stab.gain.setValueAtTime(0, start + from);
      stab.gain.linearRampToValueAtTime(1, start + from + 0.008);
      stab.gain.setValueAtTime(1, start + to - 0.02);
      stab.gain.linearRampToValueAtTime(0, start + to);
    }
    const voices = HORN_NOTES_HZ.map((hz, index) => {
      const osc = context.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = hz;
      osc.detune.value = HORN_DETUNE_CENTS[index];
      const share = context.createGain();
      share.gain.value = 1 / HORN_NOTES_HZ.length;
      osc.connect(share).connect(stab);
      osc.start(start);
      osc.stop(end);
      return osc;
    });
    return { sources: voices, out, end };
  };

  const builders: Record<FxSound, (start: number) => Voice> = {
    applause,
    tambourine,
    cheer,
    'air-horn': airHorn,
  };

  const release = (voice: Voice) => {
    active -= 1;
    voice.out.disconnect();
    if (active === 0 && wired) {
      bus.disconnect();
      wired = false;
    }
  };

  return {
    play: (sound) => {
      if (active >= maxVoices) {
        return false;
      }
      if (!wired) {
        bus.connect(destination);
        wired = true;
      }
      active += 1;
      const voice = builders[sound](context.currentTime + START_LEAD_SEC);
      voice.sources[0].addEventListener('ended', () => release(voice), { once: true });
      return true;
    },
    playing: () => active,
  };
};
