/**
 * FireSong launch flags. The Fire TV app opens `/?tv=1&mode=noraebang`; the
 * SPA drops the query on its first navigation, so the flags are kept in
 * session storage and survive reloads of the same WebView.
 */
export type FireSongLaunch = {
  /** The page is the TV (`?tv=1`): it takes the `/rtc` TV seat and has no local mic. */
  tv: boolean;
  /** Noraebang mode (`?mode=noraebang`). */
  noraebang: boolean;
};

const STORAGE_KEY = 'firesong.launch';
const NONE: FireSongLaunch = { tv: false, noraebang: false };

const fromStorage = (storage: Storage | null): FireSongLaunch | null => {
  const raw = storage?.getItem(STORAGE_KEY) ?? null;
  if (raw === null) {
    return null;
  }
  const flags = new Set(raw.split(','));
  return { tv: flags.has('tv'), noraebang: flags.has('noraebang') };
};

const toStorage = (launch: FireSongLaunch): string =>
  [launch.tv ? 'tv' : '', launch.noraebang ? 'noraebang' : ''].filter(Boolean).join(',');

const sessionStore = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

/** Reads the flags from the URL when it names any, otherwise from the session. */
export const parseFireSongLaunch = (search: string, storage: Storage | null): FireSongLaunch => {
  const params = new URLSearchParams(search);
  if (!params.has('tv') && !params.has('mode')) {
    return fromStorage(storage) ?? NONE;
  }
  const launch = { tv: params.get('tv') === '1', noraebang: params.get('mode') === 'noraebang' };
  try {
    storage?.setItem(STORAGE_KEY, toStorage(launch));
  } catch {
    // Without session storage the flags last until the first navigation.
  }
  return launch;
};

let cached: FireSongLaunch | null = null;

export const fireSongLaunch = (): FireSongLaunch => {
  if (cached === null) {
    cached =
      typeof window === 'undefined'
        ? NONE
        : parseFireSongLaunch(window.location.search, sessionStore());
  }
  return cached;
};
