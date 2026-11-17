import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';

import { AlbumArt } from '@/features/library/components/song/album-art';
import { t, tp, useTranslation } from '@/i18n';
import { cn } from '@/shared/utils/cn';
import type { Song } from '@/types/Song';

import { useReadySongs } from '../use-ready-songs';

type Props = {
  onPick: (song: Song) => void;
  onClose: () => void;
};

const SEARCH_DEBOUNCE_MS = 350;
/** Rows Left and Right jump: about one screen. */
const JUMP_ROWS = 7;
/** Rows from the end at which the next page loads. */
const LOAD_AHEAD_ROWS = 12;
/** The search field's place in the focus order. */
const SEARCH = -1;

/**
 * The TV's song book: every song that is ready to sing, in big rows for the
 * remote. Up and Down move, Left and Right jump a screen, OK picks the song,
 * Back returns to the lobby. Up from the first row reaches the search field.
 */
export function TvSongBook({ onPick, onClose }: Props) {
  useTranslation();
  const rootRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const { data, isLoading, isError, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useReadySongs(search);
  const songs = useMemo(() => data?.pages.flatMap((page) => page.processed) ?? [], [data]);
  const total = data?.pages.at(0)?.processed_count ?? 0;

  useEffect(() => {
    const timer = setTimeout(() => setSearch(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    if (active === SEARCH || songs.length === 0) {
      searchRef.current?.focus();
      return;
    }
    const row = rowRefs.current.get(Math.min(active, songs.length - 1));
    row?.focus();
    row?.scrollIntoView({ block: 'nearest' });
  }, [active, songs.length]);

  useEffect(() => {
    if (hasNextPage === true && !isFetchingNextPage && active >= songs.length - LOAD_AHEAD_ROWS) {
      void fetchNextPage();
    }
  }, [active, fetchNextPage, hasNextPage, isFetchingNextPage, songs.length]);

  const move = (target: number) => {
    setActive(Math.max(SEARCH, Math.min(target, songs.length - 1)));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const inSearch = event.target === searchRef.current;
    switch (event.key) {
      case 'Escape':
        onClose();
        break;
      case 'ArrowDown':
        move(inSearch ? 0 : active + 1);
        break;
      case 'ArrowUp':
        move(inSearch ? SEARCH : active - 1);
        break;
      case 'ArrowRight':
      case 'ArrowLeft':
        if (inSearch) {
          // The arrows move the caret in the search field.
          event.stopPropagation();
          return;
        }
        move(active + (event.key === 'ArrowRight' ? JUMP_ROWS : -JUMP_ROWS));
        break;
      default:
        event.stopPropagation();
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  // Keep the remote's keys here: focus that wanders off comes back.
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    const root = rootRef.current;
    if (
      root === null ||
      (event.relatedTarget instanceof Node && root.contains(event.relatedTarget))
    ) {
      return;
    }
    requestAnimationFrame(() => {
      if (root.isConnected && !root.contains(document.activeElement)) {
        (rowRefs.current.get(active) ?? searchRef.current)?.focus();
      }
    });
  };

  return (
    <dialog
      ref={rootRef}
      open
      aria-modal="true"
      aria-label={t('firesong.songBook.title')}
      data-nav-passthrough
      className="fixed inset-0 z-40 m-0 grid size-full max-h-none max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-[2vh] border-0 bg-linear-to-b from-slate-950 via-indigo-950 to-slate-950 px-[4vw] py-[3vh] text-white"
    >
      <header className="flex items-center gap-[3vw]">
        <h1 className="text-[5vh] leading-tight font-black">{t('firesong.songBook.title')}</h1>
        <input
          ref={searchRef}
          type="search"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setActive(SEARCH);
          }}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          placeholder={t('firesong.songBook.search')}
          aria-label={t('firesong.songBook.search')}
          className="min-w-0 flex-1 rounded-full border-[0.4vh] border-white/30 bg-white/10 px-[3vh] py-[1.2vh] text-[3vh] text-white outline-none placeholder:text-white/50 focus:border-amber-400 focus:bg-white/20"
        />
      </header>

      {songs.length === 0 ? (
        <p className="text-[3vh] text-white/60" aria-live="polite">
          {isLoading && t('firesong.songBook.loading')}
          {isError && t('firesong.songBook.error')}
          {!isLoading && !isError && t('firesong.songBook.none')}
        </p>
      ) : (
        <ul className="min-h-0 overflow-y-auto pr-[1vw] [scrollbar-width:none]">
          {songs.map((song, index) => (
            <li key={song.file_hash}>
              <button
                ref={(node) => {
                  if (node === null) {
                    rowRefs.current.delete(index);
                  } else {
                    rowRefs.current.set(index, node);
                  }
                }}
                type="button"
                tabIndex={index === active ? 0 : -1}
                onClick={() => onPick(song)}
                onFocus={() => setActive(index)}
                onKeyDown={onKeyDown}
                onBlur={onBlur}
                className={cn(
                  'flex w-full items-center gap-[2.4vh] rounded-[1.6vh] px-[2vh] py-[1vh] text-left outline-none',
                  'focus:bg-amber-400 focus:text-slate-950',
                )}
              >
                <AlbumArt
                  song={song}
                  className="size-[8vh] rounded-[1vh]"
                  fallbackIconClassName="size-[4vh]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[3.4vh] leading-tight font-bold">
                    {song.title}
                  </span>
                  <span className="block truncate text-[2.4vh] leading-tight opacity-70">
                    {song.artist}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <footer className="flex items-center justify-between gap-[2vw] text-[2.2vh] text-white/60">
        <p>{tp('firesong.songBook.count', total)}</p>
        <p>{t('firesong.songBook.keys')}</p>
      </footer>
    </dialog>
  );
}
