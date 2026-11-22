import { useId, useState } from 'react';

import { etaMinutes, formatDuration } from '@/features/phone-mic/components/format';
import { KeyTempoSteppers } from '@/features/phone-mic/components/key-tempo-steppers';
import { PartnerPicker } from '@/features/phone-mic/components/partner-picker';
import { PrepBadge } from '@/features/phone-mic/components/prep-badge';
import { SheetDialog } from '@/features/phone-mic/components/sheet-dialog';
import { SingNextToggle } from '@/features/phone-mic/components/sing-next-toggle';
import type { PhoneMicApp } from '@/features/phone-mic/lib/app';
import type { PartyState, ShiftValues } from '@/features/phone-mic/lib/party-state';
import {
  isPending,
  isReady,
  myItems,
  partnerChoices,
  reservationLimits,
} from '@/features/phone-mic/lib/party-view';
import {
  MAX_RESERVATIONS_PER_SLOT,
  type BookSong,
  type MicSlot,
} from '@/features/remote-mic/protocol';
import { t } from '@/i18n';
import { Button } from '@/shared/components/ui/button';

type ReserveSheetProps = {
  song: BookSong | null;
  app: PhoneMicApp;
  party: PartyState;
  slot: MicSlot | null;
  joined: boolean;
  offline: boolean;
  onClose: () => void;
  onJoinFirst: () => void;
};

type ReserveFormProps = Omit<ReserveSheetProps, 'song' | 'joined' | 'onJoinFirst'> & {
  song: BookSong;
};

const limitText = (party: PartyState, slot: MicSlot | null, song: BookSong): string | null => {
  if (myItems(party.snapshot, slot).some((item) => item.fileHash === song.fileHash)) {
    return t('phoneMic.failure.duplicate');
  }
  const limits = reservationLimits(party.snapshot, slot);
  if (!limits.canReserve) {
    return t('phoneMic.reserve.limitReservations', { max: MAX_RESERVATIONS_PER_SLOT });
  }
  const ready = isReady(song.prep);
  return ready || limits.canPrepare ? null : t('phoneMic.reserve.limitPreparing');
};

const notReadyText = (song: BookSong): string =>
  song.prep.etaSecs === undefined
    ? t('phoneMic.reserve.notReady')
    : t('phoneMic.reserve.notReadyEta', { minutes: etaMinutes(song.prep.etaSecs) });

function ReserveForm({ song, app, party, slot, offline, onClose }: ReserveFormProps) {
  const [settings, setSettings] = useState<ShiftValues>({ keyOffset: 0, tempo: 1 });
  const [singNext, setSingNext] = useState(false);
  const [partners, setPartners] = useState<readonly MicSlot[]>([]);
  const ready = isReady(song.prep);
  const limit = limitText(party, slot, song);
  const canSingNext = reservationLimits(party.snapshot, slot).canSingNext;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        app.party.reserve({ fileHash: song.fileHash, ...settings, singNext, partners });
        onClose();
      }}
    >
      {ready ? null : <p className="text-sm text-muted-foreground">{notReadyText(song)}</p>}
      {ready && song.shiftable ? (
        <KeyTempoSteppers values={settings} onChange={setSettings} disabled={false} />
      ) : null}
      <SingNextToggle checked={singNext} disabled={!canSingNext} onChange={setSingNext} />
      <PartnerPicker
        choices={partnerChoices(party.snapshot, slot)}
        snapshot={party.snapshot}
        selected={partners}
        onChange={setPartners}
      />
      {limit === null ? null : <output className="block text-sm text-destructive">{limit}</output>}
      <Button
        type="submit"
        size="lg"
        className="h-14 text-lg"
        disabled={offline || limit !== null || isPending(party, 'reserve')}
      >
        {t('phoneMic.reserve.action')}
      </Button>
      {offline ? (
        <p className="text-center text-sm text-muted-foreground">{t('phoneMic.link.offline')}</p>
      ) : null}
    </form>
  );
}

function JoinFirst({ onJoinFirst }: { onJoinFirst: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <output className="block text-base">{t('phoneMic.reserve.joinFirst')}</output>
      <Button type="button" size="lg" className="h-14 text-lg" onClick={onJoinFirst}>
        {t('phoneMic.join.any')}
      </Button>
    </div>
  );
}

/** Tap a song: key, tempo, "Sing next", a duet partner, then Reserve. */
export function ReserveSheet({ song, joined, onJoinFirst, ...form }: ReserveSheetProps) {
  const titleId = useId();

  return (
    <SheetDialog open={song !== null} onClose={form.onClose} labelledBy={titleId}>
      {song === null ? null : (
        <div className="flex flex-col gap-4">
          <header className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-xl font-semibold break-words">
                {song.title}
              </h2>
              <p className="text-sm text-muted-foreground">
                {song.artist}
                <span aria-hidden="true"> · </span>
                <span className="tabular-nums">{formatDuration(song.durationSecs)}</span>
              </p>
            </div>
            <PrepBadge prep={song.prep} />
          </header>
          {joined ? (
            <ReserveForm key={song.fileHash} song={song} {...form} />
          ) : (
            <JoinFirst onJoinFirst={onJoinFirst} />
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
