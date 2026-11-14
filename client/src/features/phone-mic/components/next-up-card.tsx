import { PlayIcon } from 'lucide-react';

import { useNow } from '@/features/phone-mic/hooks/use-now';
import type { PartyController } from '@/features/phone-mic/lib/party-controller';
import type { PartyState } from '@/features/phone-mic/lib/party-state';
import {
  canStartNow,
  countdownEndsAt,
  countdownLeft,
  firstReadyItem,
  isPending,
} from '@/features/phone-mic/lib/party-view';
import type { MicSlot } from '@/features/remote-mic/protocol';
import { formatNumber, t } from '@/i18n';
import { Button } from '@/shared/components/ui/button';

type NextUpCardProps = {
  party: PartyState;
  controller: PartyController;
  slot: MicSlot | null;
  disabled: boolean;
};

/** In the lobby, when this phone sings the next song: the countdown and "Start now". */
export function NextUpCard({ party, controller, slot, disabled }: NextUpCardProps) {
  const now = useNow(countdownEndsAt(party));
  if (!canStartNow(party.snapshot, slot)) {
    return null;
  }
  const next = firstReadyItem(party.snapshot);
  const left = countdownLeft(party, now);

  return (
    <section
      aria-labelledby="phone-next-title"
      className="flex flex-col gap-3 rounded-2xl border border-primary/40 bg-primary/10 p-4"
    >
      <h2 id="phone-next-title" className="text-lg font-semibold">
        {t('phoneMic.remote.upNext', { title: next?.title ?? '' })}
      </h2>
      {left === null ? null : (
        <p aria-live="polite" className="text-base">
          {t('phoneMic.countdown.you', { secs: formatNumber(left) })}
        </p>
      )}
      <Button
        type="button"
        size="lg"
        className="h-14 text-lg"
        disabled={disabled || isPending(party, 'control')}
        onClick={() => controller.control('start-now')}
      >
        <PlayIcon className="size-6" />
        {t('phoneMic.remote.startNow')}
      </Button>
    </section>
  );
}
