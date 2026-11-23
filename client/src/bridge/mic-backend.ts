import { MicRack, type MicRackPort } from '@/audio/mic-rack';
import { getVoiceEngine } from '@/audio/voice-engine';
import type { LatencyTestOutput } from '@/features/microphone/lib/latency-test';
import type { MicSlot } from '@/features/remote-mic/protocol';

import type { FlightFields } from './flight';
import { TvMicPeer, type PeerInit, type PeerPort } from './remote-mic-peer';

/**
 * Where the TV receives and plays the phones' voices: in the page (`web`:
 * browser peer connections and Web Audio strips) or in the FireSong TV app's
 * voice engine (`native`).
 */
export type MicBackend = {
  readonly kind: 'web' | 'native';
  readonly rack: MicRackPort;
  createPeer(init: PeerInit): PeerPort;
  /** Where the scoring beep plays: web = engine.output, native = engine.speakers (the song's path). */
  calibrationOutput(): LatencyTestOutput;
  /** Native: the singer's own loop in ms (monitor beep); web: always null. */
  measureMonitor(slot: MicSlot): Promise<number | null>;
  /** Native: the engine is gone and the page must fall back to web; web: never fires. */
  onLost(listener: (why: string) => void): () => void;
  /** `kind` and, for native, the engine's latest statistics. */
  flightSample(): FlightFields;
};

let web: Promise<MicBackend> | null = null;

const createWebBackend = async (): Promise<MicBackend> => {
  const engine = getVoiceEngine();
  const rack = await MicRack.create(engine);
  return {
    kind: 'web',
    rack,
    createPeer: (init) => new TvMicPeer(init),
    calibrationOutput: () => ({ context: engine.context, destination: engine.output }),
    measureMonitor: () => Promise.resolve(null),
    onLost: () => () => undefined,
    flightSample: () => ({ kind: 'web' }),
  };
};

/** The web backend; one per page. */
export const webMicBackend = (): Promise<MicBackend> => {
  web ??= createWebBackend();
  return web;
};

/** The backend for this page load: the web one. */
export const chooseMicBackend = (): Promise<MicBackend> => webMicBackend();
