/**
 * Noraebang 0-100 display score, derived from Nightingale's raw 0-1000 score.
 *
 * The raw score stays what profiles, stars and leaderboards store. The display
 * score is shown on the TV and sent to phones only. It is deliberately
 * generous: a decent attempt lands around 80-95, as on a noraebang machine.
 *
 *   v = voiced ratio (time the singer had a detected pitch while the song had
 *       one, over the song's singable time)
 *   p = min(1, raw / RAW_FULL)
 *   v < VOICED_MIN: shown = raw / 10                  (nobody sang: honest)
 *   otherwise:      F = 40 + 20 * min(1, v / 0.6)     (participation floor)
 *                   shown = F + (100 - F) * (1 - (1 - p)^2) + jitter
 *   shown >= 98 snaps to 100.
 */

import {
  MAX_DISPLAY_SCORE,
  MAX_RAW_SCORE,
  scoreTierFor,
  type ScoreTier,
} from '@/features/remote-mic/protocol';

/** Raw score that already earns the full curve. */
export const RAW_FULL = 650;
/** Below this voiced ratio the honest raw / 10 is shown. */
export const VOICED_MIN = 0.1;
/** Participation floor at the minimum voiced ratio. */
export const FLOOR_MIN = 40;
/** Extra floor at full participation. */
export const FLOOR_SPAN = 20;
/** Voiced ratio that earns the whole floor. */
export const VOICED_FULL = 0.6;
/** Display scores at or above this become 100. */
export const PERFECT_SNAP = 98;
/** Jitter range, in display points either way. */
export const JITTER_MAX = 2;

export type DisplayScoreInput = {
  /** Nightingale raw score, 0-1000. */
  rawScore: number;
  /** Voiced time over singable time, 0-1. */
  voicedRatio: number;
  /** Whole display points, -JITTER_MAX..JITTER_MAX (see `scoreJitter`). */
  jitter?: number;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const finiteOr = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

export function noraebangDisplayScore({
  rawScore,
  voicedRatio,
  jitter = 0,
}: DisplayScoreInput): number {
  const raw = clamp(finiteOr(rawScore, 0), 0, MAX_RAW_SCORE);
  const voiced = clamp(finiteOr(voicedRatio, 0), 0, 1);

  if (voiced < VOICED_MIN) {
    return clamp(Math.round(raw / 10), 0, MAX_DISPLAY_SCORE);
  }

  const floor = FLOOR_MIN + FLOOR_SPAN * Math.min(1, voiced / VOICED_FULL);
  const progress = Math.min(1, raw / RAW_FULL);
  const curved = floor + (MAX_DISPLAY_SCORE - floor) * (1 - (1 - progress) ** 2);
  const shown = clamp(
    Math.round(curved + clamp(finiteOr(jitter, 0), -JITTER_MAX, JITTER_MAX)),
    0,
    MAX_DISPLAY_SCORE,
  );
  return shown >= PERFECT_SNAP ? MAX_DISPLAY_SCORE : shown;
}

/**
 * Deterministic jitter for one performance (for example `<song hash>:<player id>`),
 * so the TV, the phone and a re-render all show the same number.
 */
export function scoreJitter(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 0x01000193) >>> 0;
  }
  return (hash % (2 * JITTER_MAX + 1)) - JITTER_MAX;
}

export type NoraebangScore = {
  displayScore: number;
  rawScore: number;
  tier: ScoreTier;
};

export function noraebangScore(input: DisplayScoreInput): NoraebangScore {
  const displayScore = noraebangDisplayScore(input);
  return {
    displayScore,
    rawScore: Math.round(clamp(finiteOr(input.rawScore, 0), 0, MAX_RAW_SCORE)),
    tier: scoreTierFor(displayScore),
  };
}

/** 1-based competition ranks ("1, 1, 3"): display score first, raw score breaks ties. */
export function rankScores(scores: readonly NoraebangScore[]): number[] {
  return scores.map(
    (score) =>
      1 +
      scores.filter(
        (other) =>
          other.displayScore > score.displayScore ||
          (other.displayScore === score.displayScore && other.rawScore > score.rawScore),
      ).length,
  );
}
