import { SearchIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { etaMinutes } from '@/features/phone-mic/components/format';
import { ReserveSheet } from '@/features/phone-mic/components/reserve-sheet';
import { SongRow } from '@/features/phone-mic/components/song-row';
import { useStore } from '@/features/phone-mic/hooks/use-store';
import type { PhoneMicApp } from '@/features/phone-mic/lib/app';
import type { PartyState } from '@/features/phone-mic/lib/party-state';
import type { SongBook, SongBookView } from '@/features/phone-mic/lib/song-book';
import { MAX_SEARCH_CHARS, type BookSong, type MicSlot } from '@/features/remote-mic/protocol';
import { formatNumber, t } from '@/i18n';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';

type SongsTabProps = {
  app: PhoneMicApp;
  party: PartyState;
  slot: MicSlot | null;
  joined: boolean;
  offline: boolean;
  /** Switch to the Sing tab, where the join card is. */
  onJoinFirst: () => void;
  active: boolean;
};

const dividerText = (first: BookSong | undefined): string =>
  first?.prep.etaSecs === undefined
    ? t('phoneMic.songs.dividerNoEta')
    : t('phoneMic.songs.divider', { minutes: etaMinutes(first.prep.etaSecs) });

/** Loads the next page when the end of the list scrolls into view. */
const useLoadMoreSentinel = (book: SongBook, view: SongBookView) => {
  const ref = useRef<HTMLDivElement>(null);
  const more = view.status === 'ready' && view.items.length < view.total && !view.moreFailed;
  /** A new page re-arms the observer, so a sentinel still in view asks for the next one. */
  const nextSkip = more ? view.items.length : null;

  useEffect(() => {
    const sentinel = ref.current;
    if (sentinel === null || nextSkip === null) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          book.loadMore();
        }
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [book, nextSkip]);

  return ref;
};

function BookStatus({ view, onRetry }: { view: SongBookView; onRetry: () => void }) {
  switch (view.status) {
    case 'idle':
    case 'loading':
      return <p className="py-8 text-center text-muted-foreground">{t('common.loading')}</p>;
    case 'expired':
      return (
        <p role="alert" className="py-8 text-center text-base">
          {t('phoneMic.songs.expired')}
        </p>
      );
    case 'failed':
      return (
        <div role="alert" className="flex flex-col items-center gap-3 py-8 text-center">
          <p className="text-base">{t('phoneMic.songs.failed')}</p>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="h-12 px-6"
            onClick={onRetry}
          >
            {t('common.actions.retry')}
          </Button>
        </div>
      );
    case 'ready':
      return view.items.length === 0 ? (
        <p className="py-8 text-center text-muted-foreground">
          {view.text.trim() === '' ? t('phoneMic.songs.emptyLibrary') : t('phoneMic.songs.empty')}
        </p>
      ) : null;
  }
  view.status satisfies never;
  return null;
}

function BookList({
  view,
  party,
  slot,
  onPick,
}: {
  view: SongBookView;
  party: PartyState;
  slot: MicSlot | null;
  onPick: (song: BookSong) => void;
}) {
  const reserved = new Set(
    (party.snapshot?.queue ?? [])
      .filter((item) => slot !== null && item.singers.includes(slot))
      .map((item) => item.fileHash),
  );

  return (
    <ul className="flex flex-col" aria-label={t('phoneMic.tabs.songs')}>
      {view.items.map((song, index) => (
        <li key={song.fileHash}>
          {index === view.readyTotal ? (
            <h3 className="border-t px-1 pt-4 pb-2 text-sm font-medium text-muted-foreground">
              {dividerText(song)}
            </h3>
          ) : null}
          <SongRow song={song} reserved={reserved.has(song.fileHash)} onPick={() => onPick(song)} />
        </li>
      ))}
    </ul>
  );
}

/** Songs: the whole library, ready songs first; tap one to reserve it. */
export function SongsTab({
  app,
  party,
  slot,
  joined,
  offline,
  onJoinFirst,
  active,
}: SongsTabProps) {
  const book = app.songBook;
  const view = useStore(book);
  const [picked, setPicked] = useState<BookSong | null>(null);
  const searchId = useId();
  const sentinel = useLoadMoreSentinel(book, view);

  useEffect(() => {
    if (active) {
      book.open();
    }
  }, [active, book]);

  return (
    <div className="flex flex-col gap-3">
      <div className="sticky top-0 z-10 -mx-4 bg-background/95 px-4 pt-1 pb-2 backdrop-blur">
        <label htmlFor={searchId} className="sr-only">
          {t('phoneMic.songs.searchLabel')}
        </label>
        <div className="relative">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={searchId}
            type="search"
            value={view.text}
            onChange={(event) => book.setText(event.target.value)}
            placeholder={t('phoneMic.songs.searchPlaceholder')}
            maxLength={MAX_SEARCH_CHARS}
            autoComplete="off"
            enterKeyHint="search"
            className="h-12 pl-10 text-base"
          />
        </div>
      </div>
      {view.status === 'ready' && view.text.trim() !== '' && view.total > 0 ? (
        <p aria-live="polite" className="px-1 text-sm text-muted-foreground">
          {t('phoneMic.songs.matches', {
            count: formatNumber(view.total),
            ready: formatNumber(view.readyTotal),
          })}
        </p>
      ) : null}
      {view.status === 'ready' && view.readyTotal > 0 ? (
        <p className="px-1 text-sm font-medium text-muted-foreground">
          {t('phoneMic.songs.readyHeading')}
        </p>
      ) : null}
      {view.status === 'ready' ? (
        <BookList view={view} party={party} slot={slot} onPick={setPicked} />
      ) : null}
      <BookStatus view={view} onRetry={() => book.retry()} />
      <div ref={sentinel} aria-hidden="true" />
      {view.loadingMore ? (
        <p className="py-4 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : null}
      {view.moreFailed ? (
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="h-12"
          onClick={() => book.retry()}
        >
          {t('phoneMic.songs.loadMore')}
        </Button>
      ) : null}
      <ReserveSheet
        song={picked}
        app={app}
        party={party}
        slot={slot}
        joined={joined}
        offline={offline}
        onClose={() => setPicked(null)}
        onJoinFirst={() => {
          setPicked(null);
          onJoinFirst();
        }}
      />
    </div>
  );
}
