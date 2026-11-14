import { CheckIcon } from 'lucide-react';

import { formatDuration } from '@/features/phone-mic/components/format';
import { PrepBadge } from '@/features/phone-mic/components/prep-badge';
import type { BookSong } from '@/features/remote-mic/protocol';
import { t } from '@/i18n';

type SongRowProps = {
  song: BookSong;
  reserved: boolean;
  onPick: () => void;
};

/** One song book entry: title, artist, length and how ready it is. */
export function SongRow({ song, reserved, onPick }: SongRowProps) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex min-h-16 w-full items-center gap-3 rounded-lg px-1 py-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring active:bg-muted"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-medium">{song.title}</span>
        <span className="block truncate text-sm text-muted-foreground">
          {song.artist}
          <span aria-hidden="true"> · </span>
          <span className="tabular-nums">{formatDuration(song.durationSecs)}</span>
        </span>
      </span>
      {reserved ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
          <CheckIcon aria-hidden="true" className="size-4" />
          {t('phoneMic.songs.reserved')}
        </span>
      ) : null}
      {song.prep.state === 'ready' ? null : <PrepBadge prep={song.prep} />}
    </button>
  );
}
