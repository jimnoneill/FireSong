import { useEffect, useRef, useState } from 'react';

import { t } from '@/i18n';
import { useLatestRef } from '@/shared/hooks/use-latest-ref';

import type { RevealSounds } from './audio/reveal-synth';
import { TIER_CAPTIONS } from './captions';
import type { RevealEntry } from './reveal-entries';

export type RevealTiming = {
  /** Drum roll before the first singer's score, ms. */
  firstRollMs: number;
  /** Drum roll before every later singer's score, ms. */
  nextRollMs: number;
  /** Time a score stays alone on screen, ms. */
  holdMs: number;
  /** Hold for a 100, which gets the long fanfare and fireworks, ms. */
  perfectHoldMs: number;
  /** How often the rolling digits change, ms. */
  tickMs: number;
};

export const DEFAULT_REVEAL_TIMING: RevealTiming = {
  firstRollMs: 2400,
  nextRollMs: 1600,
  holdMs: 1800,
  perfectHoldMs: 4200,
  tickMs: 70,
};

/** One singer at a time: rolling digits, then the score; `done` shows everyone. */
export type RevealStage =
  | { kind: 'rolling'; index: number }
  | { kind: 'shown'; index: number }
  | { kind: 'done' };

function nextStage(stage: RevealStage, count: number): RevealStage {
  if (stage.kind === 'rolling') {
    return { kind: 'shown', index: stage.index };
  }
  if (stage.kind === 'shown' && stage.index + 1 < count) {
    return { kind: 'rolling', index: stage.index + 1 };
  }
  return { kind: 'done' };
}

function stageDelayMs(
  stage: RevealStage,
  entries: readonly RevealEntry[],
  timing: RevealTiming,
): number {
  if (stage.kind === 'done') {
    return 0;
  }
  if (stage.kind === 'rolling') {
    return stage.index === 0 ? timing.firstRollMs : timing.nextRollMs;
  }
  return entries[stage.index].score.tier === 'perfect' ? timing.perfectHoldMs : timing.holdMs;
}

const stageKey = (stage: RevealStage): string =>
  stage.kind === 'done' ? 'done' : `${stage.kind}:${stage.index}`;

/**
 * Drives the reveal. Sounds start once per stage (also under StrictMode's
 * double effects); `skip` jumps to the end and silences the sounds.
 */
export function useRevealStages(
  entries: readonly RevealEntry[],
  sounds: RevealSounds,
  timing: RevealTiming,
  onRevealed: () => void,
) {
  const [stage, setStage] = useState<RevealStage>(() =>
    entries.length === 0 ? { kind: 'done' } : { kind: 'rolling', index: 0 },
  );
  const soundsRef = useLatestRef(sounds);
  const onRevealedRef = useLatestRef(onRevealed);
  const playedRef = useRef<string | null>(null);

  useEffect(() => {
    const firstVisit = playedRef.current !== stageKey(stage);
    playedRef.current = stageKey(stage);
    if (firstVisit) {
      playStage(stage, entries, timing, {
        sounds: soundsRef.current,
        onRevealed: onRevealedRef.current,
      });
    }
    if (stage.kind === 'done') {
      return undefined;
    }
    const timer = window.setTimeout(
      () => setStage(nextStage(stage, entries.length)),
      stageDelayMs(stage, entries, timing),
    );
    return () => window.clearTimeout(timer);
  }, [entries, onRevealedRef, soundsRef, stage, timing]);

  const skip = () => {
    if (stage.kind !== 'done') {
      soundsRef.current.stop();
      setStage({ kind: 'done' });
    }
  };

  return { stage, skip };
}

function playStage(
  stage: RevealStage,
  entries: readonly RevealEntry[],
  timing: RevealTiming,
  { sounds, onRevealed }: { sounds: RevealSounds; onRevealed: () => void },
): void {
  switch (stage.kind) {
    case 'done':
      onRevealed();
      return;
    case 'rolling':
      sounds.drumRoll(stageDelayMs(stage, entries, timing) / 1000);
      return;
    case 'shown':
      sounds.slam();
      sounds.celebrate(entries[stage.index].score.tier);
  }
}

/** Random two-digit numbers while `active`. */
export function useRollingValue(active: boolean, tickMs: number, random: () => number): number {
  const [value, setValue] = useState(0);
  const randomRef = useLatestRef(random);

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const timer = window.setInterval(
      () => setValue(Math.floor(randomRef.current() * 100) % 100),
      tickMs,
    );
    return () => window.clearInterval(timer);
  }, [active, randomRef, tickMs]);

  return value;
}

/** What a screen reader announces for the stage. */
export function revealAnnouncement(stage: RevealStage, entries: readonly RevealEntry[]): string {
  if (stage.kind === 'rolling') {
    return t('firesong.noraebang.reveal.counting');
  }
  const shown = stage.kind === 'done' ? entries : [entries[stage.index]];
  return shown
    .map((entry) =>
      t('firesong.noraebang.reveal.result', {
        name: entry.name,
        score: entry.score.displayScore,
        tier: t(TIER_CAPTIONS[entry.score.tier].gloss),
      }),
    )
    .join(' ');
}
