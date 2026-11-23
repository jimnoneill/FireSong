import { useInfiniteQuery } from '@tanstack/react-query';

import { loadSongs } from '@/bridge/songs';
import { SONGS } from '@/shared/query-keys';

const PAGE_SIZE = 40;

/** Songs that are ready to sing, by artist then title, for the TV song book. */
export function useReadySongs(search: string) {
  return useInfiniteQuery({
    queryKey: [...SONGS, 'tv-song-book', search],
    queryFn: ({ pageParam = 0 }: { pageParam?: number }) =>
      loadSongs({
        search: search === '' ? null : search,
        title_artist_only: true,
        filters: {
          artist: null,
          album: null,
          playlist: null,
          folder: null,
          query: null,
          status: 'analyzed',
          transcript_source: null,
          search: null,
        },
        sort: [
          { column: 'artist', direction: 'ascending' },
          { column: 'title', direction: 'ascending' },
        ],
        skip: pageParam,
        take: PAGE_SIZE,
      }),
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, page) => sum + page.processed.length, 0);
      return loaded < lastPage.processed_count ? loaded : undefined;
    },
    keepPreviousData: true,
  });
}
