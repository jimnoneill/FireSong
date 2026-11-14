import { useEffect, useState } from 'react';

import { usePartyTv } from './party-store';

/** Without remote input this long, the library gives way to the lobby again, ms. */
export const LOBBY_IDLE_RETURN_MS = 90_000;

/**
 * Back on the lobby opens the library. The lobby comes back with the next
 * song, or once the remote has been idle for a while, so a party left on the
 * library carries on.
 */
export function useLobbyDismissal(): { dismissed: boolean; dismiss: () => void } {
  const { songs } = usePartyTv();
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const dismissed = dismissedAt === songs;

  useEffect(() => {
    if (!dismissed) {
      return undefined;
    }
    let timer = setTimeout(() => setDismissedAt(null), LOBBY_IDLE_RETURN_MS);
    const onKey = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setDismissedAt(null), LOBBY_IDLE_RETURN_MS);
    };
    window.addEventListener('keydown', onKey, { capture: true, passive: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey, { capture: true });
    };
  }, [dismissed]);

  return { dismissed, dismiss: () => setDismissedAt(songs) };
}
