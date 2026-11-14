import { linkMessage } from '@/features/phone-mic/components/problem-message';
import { SlotDisc } from '@/features/phone-mic/components/slot-disc';
import type { PhoneMicSnapshot } from '@/features/phone-mic/lib/session';
import { slotColor, type MicSlot } from '@/features/remote-mic/protocol';
import { t } from '@/i18n';
import { playerColorOption } from '@/shared/player-colors';
import { cn } from '@/shared/utils/cn';

type StatusHeaderProps = {
  mic: PhoneMicSnapshot;
  slot: MicSlot | null;
  name: string;
};

/** Who this phone is and whether the TV hears it, on every tab. */
export function StatusHeader({ mic, slot, name }: StatusHeaderProps) {
  const color = slot === null ? null : slotColor(slot);
  const slotLabel =
    color === null
      ? t('phoneMic.join.any')
      : t('phoneMic.slotLabel', { color: t(playerColorOption(color).label) });

  return (
    <header className="shrink-0 border-b bg-background/95 pt-[env(safe-area-inset-top)] backdrop-blur">
      <div className="mx-auto flex max-w-md items-center gap-3 px-4 py-2">
        <SlotDisc color={color} size="sm" />
        <div className="min-w-0 flex-1">
          <h1 id="phone-mic-title" className="truncate text-lg font-semibold">
            {name === '' ? slotLabel : name}
            {name === '' ? null : <span className="sr-only"> {slotLabel}</span>}
          </h1>
          <p
            aria-live="polite"
            className={cn(
              'truncate text-sm',
              mic.unreachable ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {mic.unreachable ? t('phoneMic.reach.short') : linkMessage(mic.link)}
          </p>
        </div>
      </div>
    </header>
  );
}
