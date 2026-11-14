import { HandIcon, MegaphoneIcon, PartyPopperIcon, DrumIcon, type LucideIcon } from 'lucide-react';

import { useNow } from '@/features/phone-mic/hooks/use-now';
import { bucketAt, nextTokenAt } from '@/features/phone-mic/lib/budget';
import { FX_RULE, type PartyState } from '@/features/phone-mic/lib/party-state';
import { FX_BURST, type FxSound } from '@/features/remote-mic/protocol';
import { formatNumber, t, type TranslationKey } from '@/i18n';
import { cn } from '@/shared/utils/cn';

const SOUNDS: readonly { sound: FxSound; label: TranslationKey; icon: LucideIcon; tone: string }[] =
  [
    { sound: 'applause', label: 'phoneMic.fx.applause', icon: HandIcon, tone: 'bg-rose-500/20' },
    {
      sound: 'tambourine',
      label: 'phoneMic.fx.tambourine',
      icon: DrumIcon,
      tone: 'bg-amber-500/20',
    },
    {
      sound: 'cheer',
      label: 'phoneMic.fx.cheer',
      icon: PartyPopperIcon,
      tone: 'bg-fuchsia-500/20',
    },
    {
      sound: 'air-horn',
      label: 'phoneMic.fx.airHorn',
      icon: MegaphoneIcon,
      tone: 'bg-emerald-500/20',
    },
  ];

const REFRESH_MS = 250;

type FxPadProps = {
  party: PartyState;
  disabled: boolean;
  onPlay: (sound: FxSound) => void;
};

/**
 * Four big sound buttons. They share the server's budget (3, then one every
 * 2 s), shown as dots and a countdown instead of taps that silently vanish.
 */
export function FxPad({ party, disabled, onPlay }: FxPadProps) {
  const fullAt = party.fx.updatedAt + (FX_BURST - party.fx.tokens) * FX_RULE.refillMs;
  const now = useNow(party.fx.tokens < FX_BURST ? fullAt : null, REFRESH_MS);
  const tokens = bucketAt(party.fx, FX_RULE, now).tokens;
  const nextAt = nextTokenAt(party.fx, FX_RULE, now);
  const empty = tokens < 1;

  return (
    <section aria-labelledby="phone-fx-title" className="flex flex-col gap-3">
      <div className="flex items-center justify-between px-1">
        <h2 id="phone-fx-title" className="text-lg font-semibold">
          {t('phoneMic.fx.heading')}
        </h2>
        <span data-testid="fx-tokens" data-tokens={tokens} className="flex gap-1.5">
          <span className="sr-only">{t('phoneMic.fx.left', { count: formatNumber(tokens) })}</span>
          {Array.from({ length: FX_BURST }, (_, index) => (
            <span
              key={`token-${String(index)}`}
              aria-hidden="true"
              className={cn('size-2.5 rounded-full', index < tokens ? 'bg-primary' : 'bg-muted')}
            />
          ))}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {SOUNDS.map(({ sound, label, icon: Icon, tone }) => (
          <button
            key={sound}
            type="button"
            data-sound={sound}
            disabled={disabled || empty}
            onClick={() => onPlay(sound)}
            className={cn(
              'flex aspect-square flex-col items-center justify-center gap-2 rounded-2xl border text-lg font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-95 disabled:opacity-40 motion-reduce:active:scale-100',
              tone,
            )}
          >
            <Icon aria-hidden="true" className="size-12" />
            {t(label)}
          </button>
        ))}
      </div>
      <p aria-live="polite" className="min-h-5 px-1 text-sm text-muted-foreground">
        {empty && nextAt !== null && !disabled
          ? t('phoneMic.fx.cooldown', {
              secs: formatNumber(Math.max(1, Math.ceil((nextAt - now) / 1_000))),
            })
          : null}
        {disabled && !empty ? t('phoneMic.fx.noTv') : null}
      </p>
    </section>
  );
}
