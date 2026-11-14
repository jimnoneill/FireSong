import { fireSongLaunch } from '@/bridge/firesong-launch';
import type { LibraryMenuFilters } from '@/types/LibraryMenuFilters';

import { getNoraebangSettings } from './settings';

/**
 * The library's first filter. The TV in noraebang mode opens on the songs
 * that are ready to sing (the "Analysed" filter); everything else, and every
 * later choice, is unchanged.
 */
export const initialLibraryFilter = (base: LibraryMenuFilters): LibraryMenuFilters =>
  fireSongLaunch().tv && getNoraebangSettings().enabled ? { ...base, query: 'analysed' } : base;
