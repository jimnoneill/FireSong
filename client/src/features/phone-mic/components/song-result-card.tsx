import type { SongResultView } from '@/features/phone-mic/lib/session';
import type { ScoreTier } from '@/features/remote-mic/protocol';
import { formatNumber, t, type TranslationKey } from '@/i18n';
import { Button } from '@/shared/components/ui/button';

const TIER_CAPTIONS = {
  perfect: 'phoneMic.result.tier.perfect',
  excellent: 'phoneMic.result.tier.excellent',
  great: 'phoneMic.result.tier.great',
  good: 'phoneMic.result.tier.good',
  retry: 'phoneMic.result.tier.retry',
} satisfies Record<ScoreTier, TranslationKey>;

type SongResultCardProps = {
  result: SongResultView;
  onDismiss: () => void;
};

/** The singer's own 0-100 score, sent by the TV when its score reveal starts. */
export function SongResultCard({ result, onDismiss }: SongResultCardProps) {
  const ranked = result.rank !== undefined && result.singers !== undefined && result.singers > 1;

  return (
    <section
      aria-live="polite"
      aria-labelledby="phone-mic-result"
      className="flex flex-col items-center gap-2 rounded-xl border bg-card p-5 text-center"
    >
      <h2 id="phone-mic-result" className="text-sm text-muted-foreground">
        {t('phoneMic.result.heading')}
      </h2>
      {result.title === undefined ? null : (
        <p className="max-w-full truncate text-sm">{result.title}</p>
      )}
      <p className="text-7xl font-bold tabular-nums">{formatNumber(result.displayScore)}</p>
      <p lang="ko" className="text-2xl font-semibold">
        {t(TIER_CAPTIONS[result.tier])}
      </p>
      {ranked ? (
        <p className="text-sm text-muted-foreground">
          {t('phoneMic.result.rank', { rank: result.rank, singers: result.singers })}
        </p>
      ) : null}
      <Button type="button" variant="secondary" className="mt-2" onClick={onDismiss}>
        {t('common.actions.close')}
      </Button>
    </section>
  );
}
