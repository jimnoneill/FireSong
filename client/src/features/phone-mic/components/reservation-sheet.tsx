import { useId, useState } from 'react';

import { slotName } from '@/features/phone-mic/components/format';
import { KeyTempoSteppers } from '@/features/phone-mic/components/key-tempo-steppers';
import { PrepBadge } from '@/features/phone-mic/components/prep-badge';
import { SheetDialog } from '@/features/phone-mic/components/sheet-dialog';
import { SingNextToggle } from '@/features/phone-mic/components/sing-next-toggle';
import { SingerChip } from '@/features/phone-mic/components/singer-chip';
import type { PhoneMicApp } from '@/features/phone-mic/lib/app';
import type { ReservationChange } from '@/features/phone-mic/lib/party-controller';
import type { PartyState, ShiftValues } from '@/features/phone-mic/lib/party-state';
import {
  isPending,
  isReady,
  ownsItem,
  reservationLimits,
  singerFor,
} from '@/features/phone-mic/lib/party-view';
import type { MicSlot, PartyItem } from '@/features/remote-mic/protocol';
import { t } from '@/i18n';
import { Button } from '@/shared/components/ui/button';

type ReservationSheetProps = {
  item: PartyItem | null;
  app: PhoneMicApp;
  party: PartyState;
  slot: MicSlot | null;
  offline: boolean;
  onClose: () => void;
};

type OwnerFormProps = Omit<ReservationSheetProps, 'item'> & { item: PartyItem };

const changeOf = (
  item: PartyItem,
  settings: ShiftValues,
  singNext: boolean,
): ReservationChange => ({
  ...(settings.keyOffset === item.keyOffset ? {} : { keyOffset: settings.keyOffset }),
  ...(settings.tempo === item.tempo ? {} : { tempo: settings.tempo }),
  ...(singNext === item.singNext ? {} : { singNext }),
});

function OwnerForm({ item, app, party, slot, offline, onClose }: OwnerFormProps) {
  const [settings, setSettings] = useState<ShiftValues>({
    keyOffset: item.keyOffset,
    tempo: item.tempo,
  });
  const [singNext, setSingNext] = useState(item.singNext);
  const change = changeOf(item, settings, singNext);
  const changed = Object.keys(change).length > 0;
  const canSingNext = item.singNext || reservationLimits(party.snapshot, slot).canSingNext;
  const busy = offline || isPending(party, 'edit') || isPending(party, 'cancel');

  return (
    <div className="flex flex-col gap-4">
      {isReady(item.prep) && item.shiftable ? (
        <KeyTempoSteppers values={settings} onChange={setSettings} disabled={busy} />
      ) : null}
      <SingNextToggle checked={singNext} disabled={!canSingNext} onChange={setSingNext} />
      <Button
        type="button"
        size="lg"
        className="h-14 text-lg"
        disabled={busy || !changed}
        onClick={() => {
          app.party.edit(item.reservationId, change);
          onClose();
        }}
      >
        {t('phoneMic.reservation.save')}
      </Button>
      <Button
        type="button"
        variant="destructive"
        size="lg"
        className="h-12 text-base"
        disabled={busy}
        onClick={() => {
          app.party.cancel(item.reservationId);
          onClose();
        }}
      >
        {t('phoneMic.reservation.cancel')}
      </Button>
    </div>
  );
}

function PartnerForm({ item, app, party, offline, onClose }: OwnerFormProps) {
  const owner = item.singers.at(0);
  return (
    <div className="flex flex-col gap-4">
      {owner === undefined ? null : (
        <p className="text-base">
          {t('phoneMic.reservation.pickedBy', {
            name: slotName(owner, singerFor(party.snapshot, owner)),
          })}
        </p>
      )}
      <Button
        type="button"
        variant="destructive"
        size="lg"
        className="h-12 text-base"
        disabled={offline || isPending(party, 'cancel')}
        onClick={() => {
          app.party.cancel(item.reservationId);
          onClose();
        }}
      >
        {t('phoneMic.reservation.leave')}
      </Button>
    </div>
  );
}

/** One of this phone's reservations: key, tempo and "Sing next" for the owner; Leave for a partner. */
export function ReservationSheet({ item, ...form }: ReservationSheetProps) {
  const titleId = useId();

  return (
    <SheetDialog open={item !== null} onClose={form.onClose} labelledBy={titleId}>
      {item === null ? null : (
        <div className="flex flex-col gap-4">
          <header className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-xl font-semibold break-words">
                {item.title}
              </h2>
              <p className="text-sm text-muted-foreground">{item.artist}</p>
            </div>
            <PrepBadge prep={item.prep} />
          </header>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            {item.singers.map((singer) => (
              <SingerChip key={singer} slot={singer} snapshot={form.party.snapshot} />
            ))}
          </div>
          {ownsItem(item, form.slot) ? (
            <OwnerForm key={item.reservationId} item={item} {...form} />
          ) : (
            <PartnerForm item={item} {...form} />
          )}
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className="h-12 text-base"
            onClick={form.onClose}
          >
            {t('common.actions.close')}
          </Button>
        </div>
      )}
    </SheetDialog>
  );
}
