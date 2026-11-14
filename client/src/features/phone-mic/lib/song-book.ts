import {
  MAX_SEARCH_CHARS,
  parseSongBookPage,
  SONG_BOOK_COMMAND,
  type BookSong,
  type SongBookPage,
  type SongBookQuery,
} from '@/features/remote-mic/protocol';

import type { TimerPort } from './ports';

export const SONG_BOOK_PATH = `/api/cmd/${SONG_BOOK_COMMAND}`;
export const SONG_BOOK_PAGE_SIZE = 25;
export const SEARCH_DEBOUNCE_MS = 250;
const UNAUTHORIZED = 401;

/** A same-origin JSON POST; the pairing cookie rides along. */
export type HttpPost = (
  path: string,
  body: string,
) => Promise<{ status: number; json: () => Promise<unknown> }>;

export type SongBookResult =
  | { kind: 'ok'; page: SongBookPage }
  | { kind: 'expired' }
  | { kind: 'failed'; error: unknown };

/** One page of the song book (PROTOCOL.md §13.11); `expired` when the pairing token was rotated. */
export const fetchSongBookPage = async (
  post: HttpPost,
  query: SongBookQuery,
): Promise<SongBookResult> => {
  try {
    const response = await post(SONG_BOOK_PATH, JSON.stringify(query));
    if (response.status === UNAUTHORIZED) {
      return { kind: 'expired' };
    }
    if (response.status < 200 || response.status >= 300) {
      return { kind: 'failed', error: new Error(`song book: HTTP ${String(response.status)}`) };
    }
    return { kind: 'ok', page: parseSongBookPage(await response.json()) };
  } catch (error) {
    return { kind: 'failed', error };
  }
};

/** The search box text as the server takes it: trimmed, at most 100 characters, none when empty. */
export const normalizeSearch = (text: string): string | undefined => {
  const cut = Array.from(text.trim()).slice(0, MAX_SEARCH_CHARS).join('').trim();
  return cut === '' ? undefined : cut;
};

export type SongBookStatus = 'idle' | 'loading' | 'ready' | 'expired' | 'failed';

export type SongBookView = {
  /** What the search box shows. */
  text: string;
  items: readonly BookSong[];
  total: number;
  readyTotal: number;
  status: SongBookStatus;
  loadingMore: boolean;
  /** The last next-page request failed; scrolling or a tap retries it. */
  moreFailed: boolean;
};

const INITIAL_VIEW: SongBookView = {
  text: '',
  items: [],
  total: 0,
  readyTotal: 0,
  status: 'idle',
  loadingMore: false,
  moreFailed: false,
};

export type SongBookDeps = {
  post: HttpPost;
  timers: TimerPort;
  reportError: (error: unknown) => void;
};

const appendNew = (items: readonly BookSong[], page: readonly BookSong[]): BookSong[] => {
  const known = new Set(items.map((song) => song.fileHash));
  return [...items, ...page.filter((song) => !known.has(song.fileHash))];
};

/**
 * The Songs tab: a debounced search over the whole library, paged in 25s for
 * infinite scroll, with stale answers dropped.
 */
export class SongBook {
  private view: SongBookView = INITIAL_VIEW;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private search: string | undefined = undefined;
  private debounce: number | null = null;

  private readonly deps: SongBookDeps;

  constructor(deps: SongBookDeps) {
    this.deps = deps;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): SongBookView => this.view;

  /** First load when the tab opens; later opens keep what is there. */
  open(): void {
    if (this.view.status === 'idle') {
      this.startQuery();
    }
  }

  setText(text: string): void {
    this.update({ text });
    if (this.debounce !== null) {
      this.deps.timers.clearTimeout(this.debounce);
    }
    this.debounce = this.deps.timers.setTimeout(() => {
      this.debounce = null;
      const search = normalizeSearch(text);
      if (search !== this.search || this.view.status !== 'ready') {
        this.search = search;
        this.startQuery();
      }
    }, SEARCH_DEBOUNCE_MS);
  }

  loadMore(): void {
    const { status, loadingMore, items, total } = this.view;
    if (status !== 'ready' || loadingMore || items.length >= total) {
      return;
    }
    this.update({ loadingMore: true, moreFailed: false });
    this.load(this.generation, items.length);
  }

  retry(): void {
    if (this.view.moreFailed) {
      this.update({ moreFailed: false });
      this.loadMore();
      return;
    }
    this.startQuery();
  }

  private startQuery(): void {
    this.generation += 1;
    this.update({ items: [], total: 0, readyTotal: 0, status: 'loading', loadingMore: false });
    this.load(this.generation, 0);
  }

  private load(generation: number, skip: number): void {
    const query: SongBookQuery = {
      skip,
      take: SONG_BOOK_PAGE_SIZE,
      ...(this.search === undefined ? {} : { search: this.search }),
    };
    fetchSongBookPage(this.deps.post, query)
      .then((result) => this.settle(generation, result, skip))
      .catch((error: unknown) => this.deps.reportError(error));
  }

  private settle(generation: number, result: SongBookResult, skip: number): void {
    if (generation !== this.generation) {
      return;
    }
    switch (result.kind) {
      case 'ok':
        this.update({
          items: skip === 0 ? result.page.items : appendNew(this.view.items, result.page.items),
          total: result.page.total,
          readyTotal: result.page.readyTotal,
          status: 'ready',
          loadingMore: false,
        });
        return;
      case 'expired':
        this.update({ status: 'expired', loadingMore: false });
        return;
      case 'failed':
        this.deps.reportError(result.error);
        this.update(
          skip === 0
            ? { status: 'failed', loadingMore: false }
            : { loadingMore: false, moreFailed: true },
        );
        return;
    }
  }

  private update(patch: Partial<SongBookView>): void {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}
