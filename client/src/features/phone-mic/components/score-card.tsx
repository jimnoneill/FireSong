import { useEffect, useRef, useState } from 'react';

import { TIER_CAPTIONS, TIER_LINES } from '@/features/phone-mic/components/format';
import type { NightRankView, PartyState } from '@/features/phone-mic/lib/party-state';
import type { SongResultView } from '@/features/phone-mic/lib/session';
import { slotColor, type MicSlot } from '@/features/remote-mic/protocol';
import { formatDate, formatNumber, t } from '@/i18n';
import { Button } from '@/shared/components/ui/button';
import { BRAND_LOGO_URL, BRAND_NAME } from '@/shared/firesong-brand';
import { scorePoseFor } from '@/shared/firesong-score-pose';
import { playerColorOption } from '@/shared/player-colors';
import { cn } from '@/shared/utils/cn';

type ScoreCardProps = {
  result: SongResultView;
  party: PartyState;
  slot: MicSlot | null;
  name: string;
  onDismiss: () => void;
};

/** The song's artist, when the stage still shows the song this result is for. */
const artistFor = (result: SongResultView, party: PartyState): string | undefined => {
  const stage = party.snapshot?.stage;
  return stage !== undefined && stage.title === result.title ? stage.artist : undefined;
};

function RankLine({
  result,
  nightRank,
}: {
  result: SongResultView;
  nightRank: NightRankView | null;
}) {
  const duet = result.rank !== undefined && result.singers !== undefined && result.singers > 1;
  const tonight = nightRank?.rank;
  if (!duet && tonight === undefined) {
    return null;
  }
  return (
    <p className="flex flex-wrap justify-center gap-x-3 text-base font-semibold text-amber-200">
      {tonight === undefined ? null : (
        <span data-testid="night-rank">
          {t('phoneMic.result.nightRank', { rank: formatNumber(tonight) })}
        </span>
      )}
      {duet ? (
        <span className="text-white/70">
          {t('phoneMic.result.rank', { rank: result.rank, singers: result.singers })}
        </span>
      ) : null}
    </p>
  );
}

/**
 * The singer's score, made for a screenshot (9:16): mascot pose, score, tier
 * caption, song, name in the slot colour, tonight's rank, date and wordmark.
 * It never shows the join link or anything from it.
 */
export function ScoreCard({ result, party, slot, name, onDismiss }: ScoreCardProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [shownAt] = useState(() => new Date());
  const pose = scorePoseFor(result.displayScore);
  const color = slot === null ? null : slotColor(slot);
  const colorClass = color === null ? 'bg-primary' : playerColorOption(color).className;
  const artist = artistFor(result, party);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) {
      dialog.showModal();
    }
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby="phone-score-title"
      onClose={onDismiss}
      data-testid="score-card"
      className="m-0 h-dvh max-h-none w-full max-w-none bg-neutral-950 text-white backdrop:bg-black"
    >
      <div className="mx-auto flex h-full max-w-sm flex-col items-center justify-center gap-4 px-5 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
        <article className="relative flex w-full flex-col items-center gap-2 overflow-hidden rounded-3xl border border-white/10 bg-linear-to-b from-neutral-900 to-neutral-950 px-5 py-6 text-center">
          <span
            aria-hidden="true"
            className={cn('absolute top-10 size-48 rounded-full opacity-30 blur-3xl', colorClass)}
          />
          <img src={BRAND_LOGO_URL} alt={BRAND_NAME} className="relative h-9 w-auto" />
          <h2 id="phone-score-title" className="sr-only">
            {t('phoneMic.result.heading')}
          </h2>
          <img src={pose.url} alt={t(pose.alt)} className="relative size-40 object-contain" />
          <p className="relative text-8xl/none font-black tabular-nums">
            {formatNumber(result.displayScore)}
          </p>
          <p lang="ko" className="text-3xl font-bold">
            {t(TIER_CAPTIONS[result.tier])}
          </p>
          <p className="text-base text-white/80">{t(TIER_LINES[result.tier])}</p>
          {result.title === undefined ? null : (
            <div className="mt-1 max-w-full">
              <p className="truncate text-lg font-semibold">{result.title}</p>
              {artist === undefined ? null : (
                <p className="truncate text-sm text-white/70">{artist}</p>
              )}
            </div>
          )}
          <p
            className={cn(
              'max-w-full truncate rounded-full px-4 py-1 text-base font-bold text-neutral-950',
              colorClass,
            )}
          >
            {name}
          </p>
          <RankLine result={result} nightRank={party.nightRank} />
          <p className="text-xs text-white/60">{formatDate(shownAt, { dateStyle: 'long' })}</p>
        </article>
        <Button
          type="button"
          size="lg"
          variant="secondary"
          className="h-12 w-full max-w-60 text-base"
          onClick={() => ref.current?.close()}
        >
          {t('common.actions.close')}
        </Button>
      </div>
    </dialog>
  );
}
