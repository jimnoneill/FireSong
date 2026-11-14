import { useState } from 'react';

import { formatKey, formatTempo } from '@/features/phone-mic/components/format';
import { PrepBadge } from '@/features/phone-mic/components/prep-badge';
import { ReservationSheet } from '@/features/phone-mic/components/reservation-sheet';
import { SingerChip } from '@/features/phone-mic/components/singer-chip';
import { useNow } from '@/features/phone-mic/hooks/use-now';
import type { PhoneMicApp } from '@/features/phone-mic/lib/app';
import type { PartyState } from '@/features/phone-mic/lib/party-state';
import {
  countdownEndsAt,
  countdownLeft,
  isReady,
  singsIn,
} from '@/features/phone-mic/lib/party-view';
import type { MicSlot, PartyItem, PartySnapshot } from '@/features/remote-mic/protocol';
import { formatNumber, t } from '@/i18n';
import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/utils/cn';

type QueueTabProps = {
  app: PhoneMicApp;
  party: PartyState;
  slot: MicSlot | null;
  offline: boolean;
  onBrowse: () => void;
};

function NowSinging({ snapshot }: { snapshot: PartySnapshot }) {
  const stage = snapshot.stage;
  if (stage.state === 'lobby' || stage.title === undefined) {
    return null;
  }
  return (
    <section aria-labelledby="phone-now-title" className="rounded-2xl border bg-card p-4">
      <h2 id="phone-now-title" className="text-sm text-muted-foreground">
        {stage.state === 'paused' ? t('phoneMic.queue.paused') : t('phoneMic.queue.nowSinging')}
      </h2>
      <p className="truncate text-lg font-semibold">{stage.title}</p>
      {stage.artist === undefined ? null : (
        <p className="truncate text-sm text-muted-foreground">{stage.artist}</p>
      )}
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm">
        {stage.singers.map((singer) => (
          <SingerChip key={singer} slot={singer} snapshot={snapshot} />
        ))}
      </div>
    </section>
  );
}

function ItemBadges({ item }: { item: PartyItem }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs">
      {isReady(item.prep) ? null : <PrepBadge prep={item.prep} />}
      {item.singNext ? (
        <span className="rounded-full bg-primary/15 px-2 py-0.5 font-medium text-primary">
          {t('phoneMic.reserve.singNext')}
        </span>
      ) : null}
      {item.keyOffset === 0 ? null : (
        <span className="rounded-full bg-muted px-2 py-0.5">
          {t('phoneMic.queue.keyBadge', { key: formatKey(item.keyOffset) })}
        </span>
      )}
      {item.tempo === 1 ? null : (
        <span className="rounded-full bg-muted px-2 py-0.5">{formatTempo(item.tempo)}</span>
      )}
    </span>
  );
}

type QueueRowProps = {
  item: PartyItem;
  position: number;
  snapshot: PartySnapshot;
  mine: boolean;
  onEdit: () => void;
};

function QueueRow({ item, position, snapshot, mine, onEdit }: QueueRowProps) {
  return (
    <li
      className={cn(
        'flex items-start gap-3 rounded-xl px-3 py-3',
        mine ? 'border border-primary/40 bg-primary/5' : '',
      )}
    >
      <span className="w-6 shrink-0 pt-0.5 text-right text-sm text-muted-foreground tabular-nums">
        {formatNumber(position)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-base font-medium">{item.title}</span>
        <span className="truncate text-sm text-muted-foreground">{item.artist}</span>
        <span className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          {item.singers.length === 0 ? (
            <span className="text-muted-foreground">{t('phoneMic.queue.hostPick')}</span>
          ) : (
            item.singers.map((singer) => (
              <SingerChip key={singer} slot={singer} snapshot={snapshot} />
            ))
          )}
        </span>
        <ItemBadges item={item} />
      </div>
      {mine ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-11 shrink-0 px-4 text-sm"
          onClick={onEdit}
        >
          {t('common.actions.edit')}
        </Button>
      ) : null}
    </li>
  );
}

function Countdown({ party }: { party: PartyState }) {
  const now = useNow(countdownEndsAt(party));
  const left = countdownLeft(party, now);
  return left === null ? null : (
    <p aria-live="polite" className="rounded-xl bg-muted px-4 py-3 text-base">
      {t('phoneMic.countdown.next', { secs: formatNumber(left) })}
    </p>
  );
}

/** Queue: what is on, up next with singer names and colours, and this phone's songs to edit. */
export function QueueTab({ app, party, slot, offline, onBrowse }: QueueTabProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const snapshot = party.snapshot;
  if (snapshot === null) {
    return <p className="py-8 text-center text-muted-foreground">{t('common.loading')}</p>;
  }
  const more = snapshot.queueTotal - snapshot.queue.length;
  const item = snapshot.queue.find((each) => each.reservationId === editing) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <NowSinging snapshot={snapshot} />
      <Countdown party={party} />
      <h2 className="px-1 text-lg font-semibold">{t('phoneMic.actions.queue')}</h2>
      {snapshot.queue.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <p className="text-muted-foreground">{t('phoneMic.queue.empty')}</p>
          <Button type="button" size="lg" className="h-12 px-6 text-base" onClick={onBrowse}>
            {t('phoneMic.tabs.songs')}
          </Button>
        </div>
      ) : (
        <ol className="flex flex-col gap-1">
          {snapshot.queue.map((each, index) => (
            <QueueRow
              key={each.reservationId}
              item={each}
              position={index + 1}
              snapshot={snapshot}
              mine={singsIn(each, slot)}
              onEdit={() => setEditing(each.reservationId)}
            />
          ))}
        </ol>
      )}
      {more > 0 ? (
        <p className="text-center text-sm text-muted-foreground">
          {t('phoneMic.queue.more', { count: formatNumber(more) })}
        </p>
      ) : null}
      <ReservationSheet
        item={item}
        app={app}
        party={party}
        slot={slot}
        offline={offline}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}
