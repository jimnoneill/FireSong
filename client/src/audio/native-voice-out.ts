import { fireSongLaunch } from '@/bridge/firesong-launch';
import { addFlightSampler, flight } from '@/bridge/flight';
import {
  nativeVoiceEndpoint,
  nativeVoiceStats,
  type NativeVoiceStats,
} from '@/bridge/native-voice';

import { VOICE_OUT_PROCESSOR } from './rack-worklets';
import type { VoiceEngine, VoiceRoute } from './voice-engine';
import { voiceOutWorkerUrl } from './voice-out-worker';

/**
 * Native voice output in the FireSong TV app. The WebView's own output is
 * slow on the Fire TV Cube (256 ms; Android's low-latency path measured
 * 31 ms), so the voice mix goes to the app instead: worklet -> worker ->
 * loopback WebSocket -> AAudio. The speakers then carry only the song. While
 * the app is not playing the voices (socket closed, stream stopped, nothing
 * played) they go back to the speakers mix.
 */

/** Frames per block the worklet sends: 5.3 ms at 48 kHz. */
const BLOCK_FRAMES = 256;
const HEALTH_MS = 1000;
/** After the socket opens, the app has this long to start playing. */
const START_GRACE_MS = 2500;
/** A failed try is retried after this long, at most `MAX_TRIES` times per page. */
const RETRY_MS = 5000;
const MAX_TRIES = 3;

type WorkerMessage =
  | { type: 'open' }
  | { type: 'closed' }
  | { type: 'counts'; sent: number; dropped: number };

const parseWorkerMessage = (data: unknown): WorkerMessage | null => {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const type: unknown = Reflect.get(data, 'type');
  if (type === 'open' || type === 'closed') {
    return { type };
  }
  if (type === 'counts') {
    const sent: unknown = Reflect.get(data, 'sent');
    const dropped: unknown = Reflect.get(data, 'dropped');
    return typeof sent === 'number' && typeof dropped === 'number' ? { type, sent, dropped } : null;
  }
  return null;
};

const round1 = (value: number): number => Math.round(value * 10) / 10;

const statsSummary = (stats: NativeVoiceStats | null) =>
  stats === null
    ? {}
    : {
        open: stats.open,
        fillMs: round1(stats.fillMs),
        marginMs: round1(stats.marginMs),
        outputLatencyMs: stats.outputLatencyMs === null ? null : round1(stats.outputLatencyMs),
        underruns: stats.underruns,
        trimmedFrames: stats.trimmedFrames,
        jumps: stats.jumps,
        overflowFrames: stats.overflowFrames,
        xruns: stats.xruns,
        peak: Math.round(stats.peak * 1000) / 1000,
      };

/**
 * Starts the native voice output for the engine's lifetime when the page runs
 * in the TV app and was opened with `?voice=native`. Off by default: on the
 * Cube the page hands its audio over in bursts up to about 250 ms apart (the
 * WebView's own output pulls in large chunks), so the app's buffer swings and
 * runs dry (2026-11-22, 21:29 run).
 */
export function startNativeVoice(engine: VoiceEngine): void {
  if (!fireSongLaunch().nativeVoice) {
    return;
  }
  const endpoint = nativeVoiceEndpoint();
  if (endpoint === null) {
    return;
  }
  const { context } = engine;
  if (endpoint.rate !== context.sampleRate) {
    flight('native-voice', { route: 'speakers', why: 'rate', rate: context.sampleRate });
    return;
  }

  const node = new AudioWorkletNode(context, VOICE_OUT_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    processorOptions: { blockFrames: BLOCK_FRAMES },
  });
  engine.output.connect(node);
  // The processor writes silence; the connection keeps it rendering.
  node.connect(context.destination);
  const worker = new Worker(voiceOutWorkerUrl());
  const channel = new MessageChannel();
  node.port.postMessage({ out: channel.port1 }, [channel.port1]);
  worker.postMessage({ type: 'start', url: endpoint.url, audio: channel.port2 }, [channel.port2]);

  let route: VoiceRoute = 'speakers';
  let openedAt: number | null = null;
  let lastPlayed = -1;
  let tries = 1;
  let retry: number | null = null;
  let stats: NativeVoiceStats | null = null;
  let sent = 0;
  let dropped = 0;
  let reported = false;

  const setRoute = (next: VoiceRoute, why: string) => {
    if (next === route) {
      return;
    }
    route = next;
    engine.setVoiceRoute(next);
    flight('native-voice', { route: next, why, tries, ...statsSummary(stats) });
  };

  const fail = (why: string) => {
    openedAt = null;
    setRoute('speakers', why);
    worker.postMessage({ type: 'disconnect' }, []);
    if (tries < MAX_TRIES && retry === null) {
      retry = window.setTimeout(() => {
        retry = null;
        tries += 1;
        worker.postMessage({ type: 'connect' }, []);
      }, RETRY_MS);
    }
  };

  worker.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = parseWorkerMessage(event.data);
    if (message === null) {
      return;
    }
    switch (message.type) {
      case 'open':
        openedAt = performance.now();
        lastPlayed = nativeVoiceStats()?.playedFrames ?? -1;
        setRoute('native', 'open');
        break;
      case 'closed':
        if (openedAt !== null) {
          fail('closed');
        } else if (!reported) {
          reported = true;
          flight('native-voice', { route, why: 'unreachable', tries });
        }
        break;
      case 'counts':
        sent = message.sent;
        dropped = message.dropped;
        break;
    }
  });

  window.setInterval(() => {
    stats = nativeVoiceStats();
    if (route !== 'native' || openedAt === null) {
      return;
    }
    if (stats === null || !stats.open) {
      fail('stopped');
      return;
    }
    if (stats.playedFrames <= lastPlayed && performance.now() - openedAt > START_GRACE_MS) {
      fail('stalled');
      return;
    }
    lastPlayed = stats.playedFrames;
  }, HEALTH_MS);

  addFlightSampler('nativeVoice', () => ({
    route,
    tries,
    sentBlocks: sent,
    droppedBlocks: dropped,
    ...statsSummary(stats),
  }));
}
