/**
 * Echo presets for phone mics, read by the TV voice engine (MicRack).
 *
 * The engine owns the audio graph; this module only says what to build. The
 * echo is a noraebang echo: the voice, then repeats about 120 ms apart that
 * fade and darken (`ECHO_DELAY_MS` in `audio/voice-params.ts`).
 */

import { getNoraebangSettings, subscribeNoraebangSettings, type EchoPresetId } from './settings';

export type EchoPreset = {
  id: EchoPresetId;
  /** Echo send level, 0-1. */
  wet: number;
  /** Echo feedback (how long the repeats last), 0-1. */
  feedback: number;
  /** Lowpass inside the feedback loop, Hz. */
  lowpassHz: number;
  /** Send into the shared reverb, 0-1. */
  reverbSend: number;
};

export const ECHO_PRESETS: Readonly<Record<EchoPresetId, EchoPreset>> = {
  off: { id: 'off', wet: 0, feedback: 0, lowpassHz: 3500, reverbSend: 0 },
  light: { id: 'light', wet: 0.22, feedback: 0.3, lowpassHz: 3800, reverbSend: 0.1 },
  noraebang: { id: 'noraebang', wet: 0.36, feedback: 0.48, lowpassHz: 3000, reverbSend: 0.14 },
  hall: { id: 'hall', wet: 0.42, feedback: 0.55, lowpassHz: 2800, reverbSend: 0.3 },
};

/** The preset chosen in the noraebang settings. */
export function currentEchoPreset(): EchoPreset {
  return ECHO_PRESETS[getNoraebangSettings().echoPreset];
}

/** Calls `listener` with the new preset whenever the setting changes. */
export function subscribeEchoPreset(listener: (preset: EchoPreset) => void): () => void {
  let last = currentEchoPreset();
  return subscribeNoraebangSettings(() => {
    const next = currentEchoPreset();
    if (next !== last) {
      last = next;
      listener(next);
    }
  });
}

/** In noraebang mode every connected phone mic is monitored, between songs too. */
export function phoneMicMonitoringForced(): boolean {
  return getNoraebangSettings().enabled;
}
