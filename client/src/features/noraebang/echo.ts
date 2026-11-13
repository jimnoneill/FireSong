/**
 * Echo presets for phone mics, read by the TV voice engine (MicRack).
 *
 * The engine owns the audio graph; this module only says what to build. Each
 * slot's echo delay is locked to that slot's measured latency L (design §3):
 * the singer hears their own voice at 0, then the TV copy at L, 2L, 3L, which
 * sounds like noraebang echo rather than a late monitor.
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
  light: { id: 'light', wet: 0.18, feedback: 0.22, lowpassHz: 4500, reverbSend: 0.12 },
  noraebang: { id: 'noraebang', wet: 0.32, feedback: 0.38, lowpassHz: 3500, reverbSend: 0.2 },
  hall: { id: 'hall', wet: 0.42, feedback: 0.5, lowpassHz: 3000, reverbSend: 0.32 },
};

/** Shortest echo delay, ms. */
export const ECHO_MIN_DELAY_MS = 90;
/** Longest echo delay, ms; a slower slot shows a latency warning. */
export const ECHO_MAX_DELAY_MS = 220;
/** Below this latency the echo cannot hide anything; use a fixed delay. */
export const ECHO_LOW_LATENCY_MS = 60;
/** Delay used when latency is low or not measured yet, ms. */
export const ECHO_FIXED_DELAY_MS = 160;
/** Wet level is raised by this factor over budget, capped at `ECHO_MAX_WET`. */
export const ECHO_OVER_BUDGET_WET_GAIN = 1.25;
export const ECHO_MAX_WET = 0.6;

export type SlotEcho = {
  delayMs: number;
  wet: number;
  feedback: number;
  lowpassHz: number;
  reverbSend: number;
  /** Latency is above `ECHO_MAX_DELAY_MS`: the TV should warn. */
  latencyWarning: boolean;
};

/** Echo settings for one slot, from the preset and the slot's latency (ms, or null). */
export function slotEcho(preset: EchoPreset, latencyMs: number | null): SlotEcho {
  const measured = latencyMs !== null && Number.isFinite(latencyMs) && latencyMs >= 0;
  const latency = measured ? latencyMs : null;
  const overBudget = latency !== null && latency > ECHO_MAX_DELAY_MS;
  const delayMs =
    latency === null || latency < ECHO_LOW_LATENCY_MS
      ? ECHO_FIXED_DELAY_MS
      : Math.min(ECHO_MAX_DELAY_MS, Math.max(ECHO_MIN_DELAY_MS, latency));
  const wet = overBudget
    ? Math.min(ECHO_MAX_WET, preset.wet * ECHO_OVER_BUDGET_WET_GAIN)
    : preset.wet;

  return {
    delayMs,
    wet,
    feedback: preset.feedback,
    lowpassHz: preset.lowpassHz,
    reverbSend: preset.reverbSend,
    latencyWarning: overBudget,
  };
}

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
