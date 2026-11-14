import { useEffect, useState } from 'react';

/**
 * The wall clock, re-read every `intervalMs` while `active`, for countdowns and
 * cooldowns. While inactive it keeps the last reading.
 */
export const useNow = (active: boolean, intervalMs = 1_000): number => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);

  return now;
};
