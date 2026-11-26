import { z } from 'zod';

import { MicRack, type MicRackPort } from '@/audio/mic-rack';
import { NativeMicRack } from '@/audio/native-mic-rack';
import { getVoiceEngine } from '@/audio/voice-engine';
import type { LatencyTestOutput } from '@/features/microphone/lib/latency-test';
import { MIC_SLOTS, type MicSlot } from '@/features/remote-mic/protocol';

import { fireSongLaunch } from './firesong-launch';
import type { FlightFields } from './flight';
import { connectNativeMicLink } from './native-mic-link';
import { NativeMicPeer } from './native-mic-peer';
import type {
  AppMessage,
  EngineStats,
  NativeMicLinkPort,
  NativeSlotStatus,
} from './native-mic-protocol';
import { nativeVoiceEndpoint } from './native-voice';
import { TvMicPeer, type PeerInit, type PeerPort } from './remote-mic-peer';

export type MicBackendKind = 'web' | 'native';

/**
 * Why a monitor beep gave no loop: the app's reason (`busy`, `no-audio`,
 * `no-tone`, `stopped`), or the page's: no answer in time (`timeout`), the
 * link was lost (`lost`) or the page closed it (`closed`), the request could
 * not be sent (`unsent`), or the voices are not the app's (`not-native`).
 */
export type MonitorFailure =
  | Extract<AppMessage, { t: 'monitor-result'; ok: false }>['reason']
  | 'timeout'
  | 'lost'
  | 'closed'
  | 'unsent'
  | 'not-native';

/** The app's monitor beep: the singer's own loop in ms, or why there is none. */
export type MonitorResult = { monitorMs: number } | { monitorMs: null; reason: MonitorFailure };

const monitorFailed = (reason: MonitorFailure): MonitorResult => ({ monitorMs: null, reason });

/**
 * Where the TV receives and plays the phones' voices: in the page (`web`:
 * browser peer connections and Web Audio strips) or in the FireSong TV app's
 * voice engine (`native`).
 */
export type MicBackend = {
  readonly kind: MicBackendKind;
  /**
   * Why this backend serves: `ready` for native; for web `not-requested`,
   * `no-endpoint`, why the link to the app failed, or why it was lost.
   */
  readonly why: string;
  readonly rack: MicRackPort;
  createPeer(init: PeerInit): PeerPort;
  /** Where the scoring beep plays: web = engine.output, native = engine.speakers (the song's path). */
  calibrationOutput(): LatencyTestOutput;
  /** Native: the singer's own loop (monitor beep), or why it failed; web: always `not-native`. */
  measureMonitor(slot: MicSlot): Promise<MonitorResult>;
  /** Native: the engine is gone and the page must fall back to web; web: never fires. */
  onLost(listener: (why: string) => void): () => void;
  /** `kind`, `why`, the song's peak and, for native, the engine's latest statistics. */
  flightSample(): FlightFields;
  /**
   * Native: ends the link, so the app closes every phone's connection and
   * stops its output, puts the song back to full level and ends any monitor
   * beep still waiting (`closed`); web: nothing.
   */
  close(): void;
};

/**
 * How much later a phone's voice reaches the scorer under native than under
 * web: the scoring beep result under native minus under web, for the same
 * phone at the same spot. Null until measured on the Cube (no correction).
 */
export const NATIVE_DELIVERY_OFFSET_MS: number | null = null;

/** The song's level while the app plays the voices: song and voices each keep under half of full scale. */
const NATIVE_SONG_TRIM_DB = -8;
/**
 * On the TV the song plays this much under its mastered level, so a singer
 * sits on top of it as in a noraebang room (a -10 LUFS master left voices
 * 24 dB under the song, 2026-11-25) and the phones hear less of it.
 */
const KARAOKE_SONG_TRIM_DB = -10;
/** The app gives up on a monitor beep after about 4 s; this only ends a wait the app never answers. */
const MONITOR_TIMEOUT_MS = 6000;

let webRack: Promise<MicRackPort> | null = null;

/**
 * The web backend, `why` it serves. Every call shares the page's one
 * MicRack, which is only built the first time web is needed.
 */
export const webMicBackend = async (why: string): Promise<MicBackend> => {
  const engine = getVoiceEngine();
  webRack ??= MicRack.create(engine);
  const rack = await webRack;
  engine.setSongTrimDb(KARAOKE_SONG_TRIM_DB);
  return {
    kind: 'web',
    why,
    rack,
    createPeer: (init) => new TvMicPeer(init),
    calibrationOutput: () => ({ context: engine.context, destination: engine.output }),
    measureMonitor: () => Promise.resolve(monitorFailed('not-native')),
    onLost: () => () => undefined,
    flightSample: () => ({ kind: 'web', why, songPeak: engine.songPeak() }),
    close: () => undefined,
  };
};

const rounded = (value: number, digits: number): number => Number(value.toFixed(digits));

/** The app's own figures for a slot: ring fill, output level and the last monitor loop. */
const slotFigures = (status: NativeSlotStatus | undefined): FlightFields =>
  status === undefined
    ? {}
    : {
        fillMs: rounded(status.fillMs, 1),
        outRms: rounded(status.outRms, 4),
        monitorMs: status.monitorMs === null ? null : rounded(status.monitorMs, 1),
      };

/** The engine-stats fields as the app sent them, less the message type and the per-slot list. */
const engineFields = (stats: EngineStats): FlightFields =>
  Object.fromEntries(Object.entries(stats).filter(([key]) => key !== 't' && key !== 'slots'));

/** Engine statistics with each slot's counters and figures side by side. */
const engineSample = (
  stats: EngineStats | null,
  statuses: ReadonlyMap<MicSlot, NativeSlotStatus>,
): FlightFields => {
  const counters = stats?.slots ?? [];
  const slots = MIC_SLOTS.flatMap((slot) => {
    const counter = counters.find((entry) => entry.slot === slot);
    const status = statuses.get(slot);
    return counter === undefined && status === undefined
      ? []
      : [{ ...counter, slot, ...slotFigures(status) }];
  });
  return stats === null ? { slots } : { ...engineFields(stats), slots };
};

/**
 * The native backend on an open link. While it serves, the song plays
 * `NATIVE_SONG_TRIM_DB` lower, because the voices are summed with it after
 * the page's limiter.
 */
const nativeMicBackend = (link: NativeMicLinkPort): MicBackend => {
  const engine = getVoiceEngine();
  const statuses = new Map<MicSlot, NativeSlotStatus>();
  /** The monitor beeps still waiting, so a lost or closed link ends them at once. */
  const pendingMonitors = new Set<(result: MonitorResult) => void>();
  const endMonitors = (reason: MonitorFailure): void => {
    for (const finish of Array.from(pendingMonitors)) {
      finish(monitorFailed(reason));
    }
  };
  let lastMonitorId = 0;
  link.subscribe((message) => {
    if (message.t === 'status') {
      statuses.clear();
      for (const status of message.slots) {
        statuses.set(status.slot, status);
      }
    }
  });
  // Before any listener of the page's, which closes the link to fall back.
  link.onLost(() => endMonitors('lost'));
  engine.setSongTrimDb(NATIVE_SONG_TRIM_DB);

  const measureMonitor = (slot: MicSlot): Promise<MonitorResult> =>
    new Promise((resolve) => {
      lastMonitorId += 1;
      const id = lastMonitorId;
      const cleanups: (() => void)[] = [];
      const finish = (result: MonitorResult): void => {
        pendingMonitors.delete(finish);
        for (const cleanup of cleanups.splice(0)) {
          cleanup();
        }
        resolve(result);
      };
      pendingMonitors.add(finish);
      const timer = setTimeout(() => finish(monitorFailed('timeout')), MONITOR_TIMEOUT_MS);
      cleanups.push(
        () => clearTimeout(timer),
        link.subscribe((message) => {
          if (message.t === 'monitor-result' && message.id === id) {
            finish(message.ok ? { monitorMs: message.monitorMs } : monitorFailed(message.reason));
          }
        }),
      );
      if (!link.send({ t: 'measure-monitor', id, slot })) {
        finish(monitorFailed('unsent'));
      }
    });

  return {
    kind: 'native',
    why: 'ready',
    rack: new NativeMicRack(link),
    createPeer: (init) => new NativeMicPeer(link, init),
    calibrationOutput: () => ({ context: engine.context, destination: engine.speakers }),
    measureMonitor,
    onLost: (listener) => link.onLost(listener),
    flightSample: () => ({
      kind: 'native',
      why: 'ready',
      songPeak: engine.songPeak(),
      ...engineSample(link.latestEngineStats(), statuses),
      tapArrival: link.tapArrival(),
    }),
    close: () => {
      link.close();
      engine.setSongTrimDb(KARAOKE_SONG_TRIM_DB);
      endMonitors('closed');
    },
  };
};

/**
 * The backend for this page load, chosen once: native when the page was
 * launched with `?voice=native`, the app offers its voice door, and the door
 * answers `ready` within 3 s; web otherwise.
 */
export const chooseMicBackend = async (): Promise<MicBackend> => {
  if (!fireSongLaunch().nativeVoice) {
    return webMicBackend('not-requested');
  }
  const endpoint = nativeVoiceEndpoint();
  if (endpoint === null) {
    return webMicBackend('no-endpoint');
  }
  let link: NativeMicLinkPort;
  try {
    link = await connectNativeMicLink(endpoint);
  } catch (error) {
    return webMicBackend(error instanceof Error ? error.message : String(error));
  }
  return nativeMicBackend(link);
};

/** The backend a persisted calibration was measured on; none recorded means every older one, web. */
export type CalibrationBackend = MicBackendKind | 'assumed-web';

const CALIBRATIONS_KEY = 'firesong.calBackend.v1';
/** As many as the server keeps calibrations for. */
const CALIBRATIONS_MAX = 64;

const calibrationsSchema = z.array(z.tuple([z.string(), z.enum(['web', 'native'])]));

let calibrations: Map<string, MicBackendKind> | null = null;

const localStore = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const readCalibrations = (): Map<string, MicBackendKind> => {
  try {
    const raw = localStore()?.getItem(CALIBRATIONS_KEY) ?? null;
    const parsed = raw === null ? null : calibrationsSchema.safeParse(JSON.parse(raw));
    return new Map(parsed?.success === true ? parsed.data : []);
  } catch {
    return new Map();
  }
};

/** In memory for the page, and best effort in local storage for later page loads. */
const knownCalibrations = (): Map<string, MicBackendKind> => {
  calibrations ??= readCalibrations();
  return calibrations;
};

/** Notes that this TV calibrated `micId` while voices went through `kind`. */
export const recordCalibrationBackend = (micId: string, kind: MicBackendKind): void => {
  const known = knownCalibrations();
  known.delete(micId);
  known.set(micId, kind);
  for (const oldest of [...known.keys()].slice(0, Math.max(0, known.size - CALIBRATIONS_MAX))) {
    known.delete(oldest);
  }
  try {
    localStore()?.setItem(CALIBRATIONS_KEY, JSON.stringify([...known]));
  } catch {
    // Without local storage the record lasts until the page reloads.
  }
};

export const calibrationBackend = (micId: string): CalibrationBackend =>
  knownCalibrations().get(micId) ?? 'assumed-web';

const deliveryOffsetMs = (kind: CalibrationBackend, nativeOffsetMs: number | null): number =>
  kind === 'native' ? (nativeOffsetMs ?? 0) : 0;

/** What to add to a calibration measured on `calibratedOn` while voices go through `current`. */
export const backendCorrectionMs = (
  current: MicBackendKind,
  calibratedOn: CalibrationBackend,
): number =>
  deliveryOffsetMs(current, NATIVE_DELIVERY_OFFSET_MS) -
  deliveryOffsetMs(calibratedOn, NATIVE_DELIVERY_OFFSET_MS);
