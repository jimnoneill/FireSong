import type { ReactNode } from 'react';

import { useNavInput } from '@/features/menu/hooks/use-nav-input';
import type { ScoreTier } from '@/features/remote-mic/protocol';
import { t, useTranslation } from '@/i18n';
import { scorePoseFor } from '@/shared/firesong-score-pose';
import { playerColorOption } from '@/shared/player-colors';
import { cn } from '@/shared/utils/cn';

import type { RevealSounds } from '../audio/reveal-synth';
import { TIER_CAPTIONS } from '../captions';
import { useReducedMotion } from '../hooks';
import type { RevealEntry } from '../reveal-entries';
import {
  DEFAULT_REVEAL_TIMING,
  revealAnnouncement,
  useRevealStages,
  useRollingValue,
  type RevealStage,
  type RevealTiming,
} from '../reveal-stages';
import { FireworksCanvas } from './fireworks-canvas';

type Props = {
  title: string;
  artist: string;
  /** In reveal order. */
  entries: readonly RevealEntry[];
  sounds: RevealSounds;
  koreanCaptions: boolean;
  timing?: RevealTiming;
  random?: () => number;
  /** Called once, when every score is on screen (or the reveal was skipped). */
  onRevealed: () => void;
  /** Shown after the reveal: the result actions. */
  children?: ReactNode;
};

const TIER_TEXT: Readonly<Record<ScoreTier, string>> = {
  perfect: 'from-amber-100 via-yellow-300 to-amber-500',
  excellent: 'from-pink-100 via-fuchsia-300 to-rose-400',
  great: 'from-sky-100 via-cyan-300 to-blue-400',
  good: 'from-emerald-100 via-teal-300 to-emerald-400',
  retry: 'from-slate-100 via-slate-300 to-slate-400',
};

const SCORE_TEXT =
  'bg-linear-to-b bg-clip-text font-black leading-none text-transparent tabular-nums';

function TierCaption({
  tier,
  koreanCaptions,
  large,
}: {
  tier: ScoreTier;
  koreanCaptions: boolean;
  large: boolean;
}) {
  const caption = TIER_CAPTIONS[tier];
  return (
    <div className="flex flex-col items-center leading-tight" data-testid="tier-caption">
      {koreanCaptions && (
        <span lang="ko" className={cn('font-black', large ? 'text-[8vh]' : 'text-[3.2vh]')}>
          {t(caption.korean)}
        </span>
      )}
      <span
        className={cn(
          koreanCaptions ? 'font-medium text-white/80' : 'font-black',
          large ? 'text-[3.4vh]' : 'text-[2.2vh]',
          large && !koreanCaptions && 'text-[7vh]',
        )}
      >
        {t(caption.gloss)}
      </span>
    </div>
  );
}

function SingerName({ entry }: { entry: RevealEntry }) {
  return (
    <span className="flex items-center gap-3 text-[3.6vh] font-semibold">
      <span
        aria-hidden="true"
        className={cn('size-[2.4vh] rounded-full', playerColorOption(entry.color).className)}
      />
      {entry.name}
    </span>
  );
}

function RollingScore({ value, reducedMotion }: { value: number; reducedMotion: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-testid="rolling-score"
      className={cn(SCORE_TEXT, 'from-white to-white/60 text-[26vh]')}
    >
      {reducedMotion ? '··' : String(value).padStart(2, '0')}
    </span>
  );
}

/** The mascot's reaction, beside the centred score so it never covers the number or captions. */
function ScorePoseArt({
  displayScore,
  reducedMotion,
}: {
  displayScore: number;
  reducedMotion: boolean;
}) {
  const pose = scorePoseFor(displayScore);
  return (
    <img
      src={pose.url}
      alt={t(pose.alt)}
      data-testid="score-pose"
      className={cn(
        'pointer-events-none absolute inset-y-0 left-[4vw] my-auto h-[46vh] max-w-[24vw] object-contain drop-shadow-[0_1vh_3vh_rgb(0_0_0/0.5)]',
        !reducedMotion && 'animate-in fade-in slide-in-from-left-12 duration-500',
      )}
    />
  );
}

function FinalScore({ entry, koreanCaptions }: { entry: RevealEntry; koreanCaptions: boolean }) {
  const { displayScore, tier } = entry.score;
  return (
    <>
      <span
        data-testid="final-score"
        className={cn(
          SCORE_TEXT,
          'text-[30vh] drop-shadow-[0_0.6vh_2vh_rgb(0_0_0/0.6)] motion-safe:animate-in motion-safe:zoom-in-150 motion-safe:duration-300',
          TIER_TEXT[tier],
        )}
      >
        {displayScore}
      </span>
      <TierCaption tier={tier} koreanCaptions={koreanCaptions} large />
    </>
  );
}

function RankedScores({
  entries,
  koreanCaptions,
}: {
  entries: readonly RevealEntry[];
  koreanCaptions: boolean;
}) {
  const ranked = entries.toSorted((left, right) => left.rank - right.rank);
  return (
    <ol className="flex w-[min(90vw,110vh)] flex-col gap-[1.6vh]" data-testid="ranked-scores">
      {ranked.map((entry) => (
        <li
          key={entry.id}
          className={cn(
            'grid grid-cols-[8vh_1fr_auto_22vh] items-center gap-[2vh] rounded-2xl bg-black/45 px-[3vh] py-[1.6vh]',
            entry.rank === 1 && 'ring-4 ring-amber-300/80',
          )}
        >
          <span className="text-[4vh] font-black text-white/80">
            {t('firesong.noraebang.reveal.rank', { rank: entry.rank })}
          </span>
          <SingerName entry={entry} />
          <span className={cn(SCORE_TEXT, 'text-[9vh]', TIER_TEXT[entry.score.tier])}>
            {entry.score.displayScore}
          </span>
          <TierCaption tier={entry.score.tier} koreanCaptions={koreanCaptions} large={false} />
        </li>
      ))}
    </ol>
  );
}

type StageViewProps = {
  stage: RevealStage;
  entries: readonly RevealEntry[];
  rollingValue: number;
  reducedMotion: boolean;
  koreanCaptions: boolean;
};

function StageView({
  stage,
  entries,
  rollingValue,
  reducedMotion,
  koreanCaptions,
}: StageViewProps) {
  const multiplayer = entries.length > 1;
  if (stage.kind === 'done' && multiplayer) {
    return <RankedScores entries={entries} koreanCaptions={koreanCaptions} />;
  }
  const entry = stage.kind === 'done' ? entries.at(0) : entries[stage.index];
  if (entry === undefined) {
    return null;
  }
  return (
    <div key={entry.id} className="flex flex-col items-center gap-[2vh]">
      {multiplayer && <SingerName entry={entry} />}
      {stage.kind === 'rolling' ? (
        <RollingScore value={rollingValue} reducedMotion={reducedMotion} />
      ) : (
        <>
          <ScorePoseArt displayScore={entry.score.displayScore} reducedMotion={reducedMotion} />
          <FinalScore entry={entry} koreanCaptions={koreanCaptions} />
        </>
      )}
    </div>
  );
}

function celebratesPerfect(stage: RevealStage, entries: readonly RevealEntry[]): boolean {
  if (stage.kind === 'done') {
    return entries.some((entry) => entry.score.tier === 'perfect');
  }
  return stage.kind === 'shown' && entries[stage.index].score.tier === 'perfect';
}

/**
 * Full-screen noraebang score reveal: a drum roll with rolling digits, the
 * score slammed on screen with its tier caption, one singer at a time, then
 * everyone ranked. OK or Back skips to the end.
 */
export function NoraebangScoreReveal({
  title,
  artist,
  entries,
  sounds,
  koreanCaptions,
  timing = DEFAULT_REVEAL_TIMING,
  random = Math.random,
  onRevealed,
  children,
}: Props) {
  useTranslation();
  const reducedMotion = useReducedMotion();
  const { stage, skip } = useRevealStages(entries, sounds, timing, onRevealed);
  const rollingValue = useRollingValue(
    stage.kind === 'rolling' && !reducedMotion,
    timing.tickMs,
    random,
  );

  useNavInput((action) => {
    if (action.confirm || action.back) {
      skip();
    }
  });

  return (
    <dialog
      open
      aria-modal="true"
      aria-labelledby="noraebang-reveal-title"
      className="fixed inset-0 z-50 m-0 flex size-full max-h-none max-w-none flex-col items-center justify-center gap-[3vh] overflow-hidden border-0 bg-black/70 px-[4vw] py-0 text-white"
    >
      {celebratesPerfect(stage, entries) && !reducedMotion && <FireworksCanvas />}

      <header className="absolute inset-x-0 top-[5vh] px-[4vw] text-center">
        <h2 id="noraebang-reveal-title" className="truncate text-[4.2vh] font-bold">
          {title}
        </h2>
        <p className="truncate text-[2.6vh] text-white/70">{artist}</p>
      </header>

      <StageView
        stage={stage}
        entries={entries}
        rollingValue={rollingValue}
        reducedMotion={reducedMotion}
        koreanCaptions={koreanCaptions}
      />

      <output aria-live="polite" className="sr-only">
        {revealAnnouncement(stage, entries)}
      </output>

      {stage.kind === 'done' ? (
        <div className="relative z-10 flex flex-col items-center gap-2">{children}</div>
      ) : (
        <p className="absolute bottom-[4vh] text-[2vh] text-white/50">
          {t('firesong.noraebang.reveal.skipHint')}
        </p>
      )}
    </dialog>
  );
}
