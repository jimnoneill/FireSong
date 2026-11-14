import { useEffect, useState } from 'react';

/**
 * The wall clock for countdowns and cooldowns, re-read every `intervalMs`
 * until `until` (ms) has passed; with `null` it keeps the last reading.
 */
export const useNow = (until: number | null, intervalMs = 1_000): number => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (until === null) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= until) {
        window.clearInterval(timer);
      }
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [until, intervalMs]);

  return now;
};
