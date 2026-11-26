import { addFlightSampler, flight } from '@/bridge/flight';

import { rackWorkletUrl, SONG_PEAK_PROCESSOR } from './rack-worklets';
import {
  BUS_COMPRESSOR_RATIO,
  BUS_COMPRESSOR_THRESHOLD_DB,
  dbToGain,
  LIMITER_RATIO,
  LIMITER_THRESHOLD_DB,
  REVERB_SECONDS,
} from './voice-params';

/**
 * The TV's long-lived voice context. It owns every phone voice from join to
 * leave, so pauses and song changes never rebuild audio graphs or stop
 * tracks. Slots feed `bus` (dry and echo) and `reverbSend`; voices leave
 * through the bus compressor and the voice limiter, `output`. The song comes
 * in at `speakers`, its own level (the song trim, 0 dB unless set), and meets
 * the voices in a last limiter, so together they never clip. The trim acts on
 * the song alone: on the TV it keeps singers on top of the song, and with the
 * app's native voice output it leaves headroom for voices mixed in later.
 */
export type VoiceEngine = {
  readonly context: AudioContext;
  readonly bus: GainNode;
  readonly reverbSend: GainNode;
  readonly output: DynamicsCompressorNode;
  /** Where the song's stems connect: the song's own level, in front of the mix limiter. */
  readonly speakers: GainNode;
  /** Resolves once the chunker and gate worklets are loaded. */
  readonly ready: Promise<void>;
  resume(): Promise<void>;
  /** WebView output path, `baseLatency + outputLatency`, in milliseconds. */
  outputLatencyMs(): number;
  /** RMS of the last output block, the voices as they leave for the speakers. */
  outputRms(): number;
  /** The song's level at `speakers`, in dB; glides there in about 10 ms. Voices are not affected. */
  setSongTrimDb(db: number): void;
  /** Largest absolute song sample after the trim since the previous call; null before a new reading. */
  songPeak(): number | null;
};

const REVERB_DECAY = 6.9;
const LIMITER_ATTACK_SEC = 0.001;
const LIMITER_RELEASE_SEC = 0.1;
/** The whole mix only, just under full scale: it acts on peaks, not on the song's level. */
const MIX_LIMITER_THRESHOLD_DB = -1;
const MIX_LIMITER_RELEASE_SEC = 0.25;
const TRIM_GLIDE_SEC = 0.01;
const GESTURES = ['pointerdown', 'keydown'] as const;
const METER_FFT_SIZE = 2048;

/** Decaying noise, from a fixed seed so every TV gets the same room. */
const reverbImpulse = (context: BaseAudioContext): AudioBuffer => {
  const length = Math.max(1, Math.round(REVERB_SECONDS * context.sampleRate));
  const impulse = context.createBuffer(2, length, context.sampleRate);
  let seed = 0x2545f491;
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[index] = (seed / 2 ** 31 - 1) * Math.exp((-REVERB_DECAY * index) / length);
    }
  }
  return impulse;
};

const compressor = (
  context: BaseAudioContext,
  thresholdDb: number,
  ratio: number,
): DynamicsCompressorNode => {
  const node = context.createDynamicsCompressor();
  node.threshold.value = thresholdDb;
  node.ratio.value = ratio;
  return node;
};

/** Follows the peaks leaving `source` once the worklet module is loaded. */
const meterSongPeak = async (
  context: AudioContext,
  ready: Promise<void>,
  source: AudioNode,
  onPeak: (peak: number) => void,
): Promise<void> => {
  await ready;
  const meter = new AudioWorkletNode(context, SONG_PEAK_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  });
  meter.port.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (typeof event.data === 'number') {
      onPeak(event.data);
    }
  });
  meter.port.start();
  source.connect(meter);
};

export const createVoiceEngine = (context: AudioContext): VoiceEngine => {
  const bus = context.createGain();
  const reverbSend = context.createGain();
  const reverb = context.createConvolver();
  reverb.buffer = reverbImpulse(context);
  const busCompressor = compressor(context, BUS_COMPRESSOR_THRESHOLD_DB, BUS_COMPRESSOR_RATIO);
  const limiter = compressor(context, LIMITER_THRESHOLD_DB, LIMITER_RATIO);
  limiter.knee.value = 0;
  limiter.attack.value = LIMITER_ATTACK_SEC;
  limiter.release.value = LIMITER_RELEASE_SEC;
  const mix = compressor(context, MIX_LIMITER_THRESHOLD_DB, LIMITER_RATIO);
  mix.knee.value = 0;
  mix.attack.value = LIMITER_ATTACK_SEC;
  mix.release.value = MIX_LIMITER_RELEASE_SEC;
  mix.connect(context.destination);
  const speakers = context.createGain();
  speakers.connect(mix);

  bus.connect(busCompressor);
  reverbSend.connect(reverb).connect(busCompressor);
  busCompressor.connect(limiter).connect(mix);
  const meter = context.createAnalyser();
  meter.fftSize = METER_FFT_SIZE;
  limiter.connect(meter);
  const block = new Float32Array(meter.fftSize);

  const ready = context.audioWorklet.addModule(rackWorkletUrl());
  let songPeak: number | null = null;
  meterSongPeak(context, ready, speakers, (peak) => {
    songPeak = Math.max(songPeak ?? 0, peak);
  }).catch((error: unknown) => flight('song-peak', { why: 'error', error: String(error) }));

  return {
    context,
    bus,
    reverbSend,
    output: limiter,
    speakers,
    ready,
    resume: () => context.resume(),
    outputLatencyMs: () => (context.baseLatency + context.outputLatency) * 1000,
    outputRms: () => {
      meter.getFloatTimeDomainData(block);
      return Math.sqrt(block.reduce((sum, sample) => sum + sample * sample, 0) / block.length);
    },
    setSongTrimDb: (db) => {
      speakers.gain.setTargetAtTime(dbToGain(db), context.currentTime, TRIM_GLIDE_SEC);
    },
    songPeak: () => {
      const peak = songPeak;
      songPeak = null;
      return peak;
    },
  };
};

/**
 * Browsers start an AudioContext suspended until a gesture; the Fire TV app
 * allows playback without one. Resume on the next key or pointer press and
 * whenever the page becomes visible again.
 */
const keepRunning = (engine: VoiceEngine): void => {
  const { context } = engine;
  const resume = () => {
    if (context.state !== 'running') {
      engine.resume().catch(() => undefined);
    }
  };
  for (const gesture of GESTURES) {
    window.addEventListener(gesture, resume, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      resume();
    }
  });
  context.addEventListener('statechange', () => flight('voice-context', { state: context.state }));
  addFlightSampler('voice', () => ({
    state: context.state,
    outputRms: Number(engine.outputRms().toFixed(4)),
    latencyMs: Math.round(engine.outputLatencyMs()),
  }));
  resume();
};

let shared: VoiceEngine | null = null;

/**
 * The smallest output buffer the platform offers. Measured on the Fire TV Cube
 * (2026-11-22): 'interactive' gave 64 ms base + 320 ms output latency, 0 gave
 * 3 ms + 256 ms, so a singer hears themselves about 125 ms sooner.
 */
const LOWEST_LATENCY = 0;

/** The page's single voice engine, created on first use and never closed. */
export const getVoiceEngine = (): VoiceEngine => {
  if (shared === null) {
    const engine = createVoiceEngine(new AudioContext({ latencyHint: LOWEST_LATENCY }));
    shared = engine;
    keepRunning(engine);
  }
  return shared;
};
