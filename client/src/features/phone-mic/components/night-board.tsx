import { TrophyIcon } from 'lucide-react';

import { TIER_CAPTIONS } from '@/features/phone-mic/components/format';
import { SingerChip } from '@/features/phone-mic/components/singer-chip';
import type { PartyState } from '@/features/phone-mic/lib/party-state';
import { mySinger } from '@/features/phone-mic/lib/party-view';
import type { MicSlot, NightScore } from '@/features/remote-mic/protocol';
import { formatNumber, t } from '@/i18n';
import { cn } from '@/shared/utils/cn';

const yourRankText = (party: PartyState): string | null => {
  const rank = party.nightRank;
  if (rank === null) {
    return null;
  }
  return rank.rank === undefined
    ? t('phoneMic.best.notRanked')
    : t('phoneMic.best.yourRank', { rank: formatNumber(rank.rank) });
};

function ScoreRow({ score, place, mine }: { score: NightScore; place: number; mine: boolean }) {
  return (
    <li className={cn('flex items-center gap-3 rounded-xl px-3 py-2', mine ? 'bg-primary/10' : '')}>
      <span className="w-6 shrink-0 text-right text-sm text-muted-foreground tabular-nums">
        {formatNumber(place)}
      </span>
      <span className="w-12 shrink-0 text-2xl font-bold tabular-nums">
        {formatNumber(score.displayScore)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <SingerChip
          slot={score.slot}
          snapshot={null}
          {...(score.name === undefined ? {} : { name: score.name })}
          className="text-base font-medium"
        />
        {score.title === undefined ? null : (
          <span className="truncate text-sm text-muted-foreground">{score.title}</span>
        )}
      </span>
      <span lang="ko" className="shrink-0 text-sm font-semibold">
        {t(TIER_CAPTIONS[score.tier])}
      </span>
    </li>
  );
}

/** Tonight's best: the server's board, best first, and where this phone's last song landed. */
export function NightBoard({ party, slot }: { party: PartyState; slot: MicSlot | null }) {
  const scores = party.snapshot?.scores ?? [];
  const yourRank = yourRankText(party);
  const myName = mySinger(party.snapshot, slot)?.name;

  return (
    <section aria-labelledby="phone-best-title" className="flex flex-col gap-2">
      <h2 id="phone-best-title" className="flex items-center gap-2 px-1 text-lg font-semibold">
        <TrophyIcon aria-hidden="true" className="size-5 text-primary" />
        {t('phoneMic.best.heading')}
      </h2>
      {yourRank === null ? null : <p className="px-1 text-base">{yourRank}</p>}
      {scores.length === 0 ? (
        <p className="px-1 py-4 text-muted-foreground">{t('phoneMic.best.empty')}</p>
      ) : (
        <ol className="flex flex-col gap-1" data-testid="night-board">
          {scores.map((score, index) => (
            <ScoreRow
              key={`${String(score.atSecs)}-${String(score.slot)}-${String(score.rawScore)}`}
              score={score}
              place={index + 1}
              mine={score.slot === slot && score.name === myName}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
