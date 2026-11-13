import { rackWorkletUrl } from './rack-worklets';
import {
  BUS_COMPRESSOR_RATIO,
  BUS_COMPRESSOR_THRESHOLD_DB,
  LIMITER_RATIO,
  LIMITER_THRESHOLD_DB,
  REVERB_SECONDS,
} from './voice-params';

/**
 * The TV's long-lived voice context. It owns every phone voice from join to
 * leave, so pauses and song changes never rebuild audio graphs or stop
 * tracks. Slots feed `bus` (dry and echo) and `reverbSend`; everything leaves
 * through the bus compressor and the master limiter, `output`.
 */
export type VoiceEngine = {
  readonly context: AudioContext;
  readonly bus: GainNode;
  readonly reverbSend: GainNode;
  readonly output: DynamicsCompressorNode;
  /** Resolves once the chunker and gate worklets are loaded. */
  readonly ready: Promise<void>;
  resume(): Promise<void>;
  /** WebView output path, `baseLatency + outputLatency`, in milliseconds. */
  outputLatencyMs(): number;
};

const REVERB_DECAY = 6.9;
const LIMITER_ATTACK_SEC = 0.001;
const LIMITER_RELEASE_SEC = 0.1;
const GESTURES = ['pointerdown', 'keydown'] as const;

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

  bus.connect(busCompressor);
  reverbSend.connect(reverb).connect(busCompressor);
  busCompressor.connect(limiter).connect(context.destination);

  const ready = context.audioWorklet.addModule(rackWorkletUrl());

  return {
    context,
    bus,
    reverbSend,
    output: limiter,
    ready,
    resume: () => context.resume(),
    outputLatencyMs: () => (context.baseLatency + context.outputLatency) * 1000,
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
  resume();
};

let shared: VoiceEngine | null = null;

/** The page's single voice engine, created on first use and never closed. */
export const getVoiceEngine = (): VoiceEngine => {
  if (shared === null) {
    shared = createVoiceEngine(new AudioContext({ latencyHint: 'interactive' }));
    keepRunning(shared);
  }
  return shared;
};
