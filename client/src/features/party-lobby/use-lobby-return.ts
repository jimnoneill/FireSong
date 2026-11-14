import { useEffect, useState } from 'react';

import { useLatestRef } from '@/shared/hooks/use-latest-ref';

/** Seconds the score stays up before the TV goes back to the party lobby. */
export const LOBBY_RETURN_SECS = 10;

/**
 * Once `active`, counts down and then calls `onReturn` once. Returns the
 * seconds left, or `null` while inactive.
 */
export function useLobbyReturn(active: boolean, onReturn: () => void): number | null {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const onReturnRef = useLatestRef(onReturn);

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    let remaining = LOBBY_RETURN_SECS;
    const timer = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        setSecondsLeft(remaining);
        return;
      }
      clearInterval(timer);
      onReturnRef.current();
    }, 1000);
    return () => clearInterval(timer);
  }, [active, onReturnRef]);

  return active ? (secondsLeft ?? LOBBY_RETURN_SECS) : null;
}
