import { useQuery } from '@tanstack/react-query';

import { calculateCacheStats } from '@/bridge/cache';
import { fireSongLaunch } from '@/bridge/firesong-launch';
import { CACHE_STATS } from '@/shared/query-keys';

// Summing a large song cache can take the server many seconds; the TV shows
// the party over the library, so it reads the totals once instead of polling.
export const useCacheStats = () =>
  useQuery({
    queryKey: CACHE_STATS,
    queryFn: calculateCacheStats,
    refetchInterval: fireSongLaunch().tv ? false : 5000,
  });
