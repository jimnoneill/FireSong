import { getVoiceEngine } from '@/audio/voice-engine';
import { subscribeMicSamples } from '@/bridge/microphone-samples';
import type { BackendSample, RemoteMics } from '@/bridge/remote-mics';
import { SampleRing } from '@/features/microphone/lib/sample-ring';
import { partyTv, type StageReport } from '@/features/party-lobby/party-store';
import { PITCH_WINDOW_SAMPLES } from '@/features/playback/lib/pitch/constants';
import { createPitchDetector, detectPitchFromSamples } from '@/features/playback/lib/pitch/detect';
import { isMicSlot } from '@/features/remote-mic/protocol';

/**
 * Opt-in TV diagnostics for test drivers and the Cube runs (WP7). Off unless
 * the TV page was opened with `?fsdiag=1` (kept in session storage like the
 * launch flags). It exposes `window.fireSongDiag`: the phone-mic roster,
 * each slot's rack status, the voice context and backend, and the pitch of
 * the frames a capture id (a player) receives, detected exactly as
 * `useMicPitch` does. It can also drop the link to the TV app's voice engine,
 * to test the fall back to the page's own voices. It never exposes tokens,
 * `resumeKey` or SDP.
 */

const STORAGE_KEY = 'firesong.diag';
const MAX_PITCHES = 600;

type PitchWatch = { frames: number; voiced: number; pitches: number[]; stop: () => void };

export type FireSongDiag = {
  snapshot(): {
    connected: boolean;
    lastError: string | null;
    devices: { id: string; slot: number; label: string; reconnecting: boolean }[];
    latencyMs: Record<string, number>;
  };
  slotStatus(slot: number): unknown;
  engine(): { state: string; sampleRate: number; baseLatency: number; outputLatency: number };
  /** Starts recording the pitch of the frames delivered to `captureId`. */
  watchPitch(captureId: string): void;
  /** Frames seen, voiced detections, and the latest detected pitches (Hz). */
  pitches(captureId: string): { frames: number; voiced: number; pitches: number[] } | null;
  /** Fun sounds played and dropped (voice limit) since the page loaded. */
  fx(): { played: number; dropped: number };
  /** The party stage the TV last reported. */
  stage(): StageReport;
  /** Who plays the voices (`web`: the page, `native`: the TV app) and why; null while none is chosen. */
  voiceBackend(): BackendSample | null;
  /** Drops the link to the TV app's voice engine as a failure would; false when the voices are not native. */
  dropNativeLink(): boolean;
};

const GLOBAL_NAME = 'fireSongDiag';

/** `?fsdiag=1` turns diagnostics on for this tab, `?fsdiag=0` off. */
export const diagEnabled = (search: string, storage: Storage | null): boolean => {
  const flag = new URLSearchParams(search).get('fsdiag');
  try {
    if (flag === '1') {
      storage?.setItem(STORAGE_KEY, '1');
      return true;
    }
    if (flag === '0') {
      storage?.removeItem(STORAGE_KEY);
      return false;
    }
    return storage?.getItem(STORAGE_KEY) === '1';
  } catch {
    return flag === '1';
  }
};

const watchPitch = (captureId: string): PitchWatch => {
  const ring = new SampleRing(PITCH_WINDOW_SAMPLES * 2);
  const detector = createPitchDetector();
  const window = new Float32Array(PITCH_WINDOW_SAMPLES);
  const watch: PitchWatch = { frames: 0, voiced: 0, pitches: [], stop: () => undefined };
  watch.stop = subscribeMicSamples(captureId, (frame) => {
    ring.push(frame.samples);
    watch.frames += 1;
    // About 23 detections per second at 48 kHz, close to useMicPitch's 30 Hz.
    if (watch.frames % 4 !== 0 || !ring.readMostRecent(window)) {
      return;
    }
    const hz = detectPitchFromSamples(detector, window, frame.sample_rate);
    if (hz !== null) {
      watch.voiced += 1;
      watch.pitches.push(Math.round(hz * 10) / 10);
      if (watch.pitches.length > MAX_PITCHES) {
        watch.pitches.splice(0, watch.pitches.length - MAX_PITCHES);
      }
    }
  });
  return watch;
};

const sessionStore = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

/** Installs `window.fireSongDiag` when enabled; returns the uninstall function. */
export const installDiag = (mics: RemoteMics): (() => void) => {
  if (typeof window === 'undefined' || !diagEnabled(window.location.search, sessionStore())) {
    return () => undefined;
  }
  const watches = new Map<string, PitchWatch>();
  const diag: FireSongDiag = {
    snapshot: () => {
      const snapshot = mics.getSnapshot();
      return {
        connected: snapshot.connected,
        lastError: snapshot.lastError,
        devices: snapshot.devices.map(({ id, slot, label, reconnecting }) => ({
          id,
          slot,
          label,
          reconnecting,
        })),
        latencyMs: Object.fromEntries(snapshot.latencyMs),
      };
    },
    slotStatus: (slot) => (isMicSlot(slot) ? mics.slotStatus(slot) : null),
    engine: () => {
      const { context } = getVoiceEngine();
      return {
        state: context.state,
        sampleRate: context.sampleRate,
        baseLatency: context.baseLatency,
        outputLatency: context.outputLatency,
      };
    },
    watchPitch: (captureId) => {
      if (!watches.has(captureId)) {
        watches.set(captureId, watchPitch(captureId));
      }
    },
    pitches: (captureId) => {
      const watch = watches.get(captureId);
      return watch === undefined
        ? null
        : { frames: watch.frames, voiced: watch.voiced, pitches: [...watch.pitches] };
    },
    fx: () => partyTv.fxCounters(),
    stage: () => partyTv.getState().stage,
    voiceBackend: () => mics.backendSample(),
    dropNativeLink: () => mics.dropNativeLink(),
  };
  Reflect.defineProperty(window, GLOBAL_NAME, { value: diag, configurable: true });
  return () => {
    for (const watch of watches.values()) {
      watch.stop();
    }
    watches.clear();
    Reflect.deleteProperty(window, GLOBAL_NAME);
  };
};
