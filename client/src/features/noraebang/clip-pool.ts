import { useQuery } from '@tanstack/react-query';

import { listNoraebangClips, noraebangClipUrl, type NoraebangClip } from '@/bridge/noraebang-clips';

import { createClipSession, type ClipHistoryStorage, type ClipSession } from './clip-picker';

export const NORAEBANG_CLIPS = ['firesong', 'noraebang-clips'];

const POOL_STALE_MS = 5 * 60_000;

export type PlayableClip = NoraebangClip & { url: string };

async function loadClipPool(): Promise<PlayableClip[]> {
  const { clips } = await listNoraebangClips();
  return await Promise.all(
    clips.map(async (clip) => Object.assign(clip, { url: await noraebangClipUrl(clip) })),
  );
}

/** The server's clip pool with playable URLs; empty when no clip is usable. */
export function useNoraebangClipPool() {
  return useQuery({
    queryKey: NORAEBANG_CLIPS,
    queryFn: loadClipPool,
    staleTime: POOL_STALE_MS,
    retry: 1,
  });
}

function sessionStorageOrNull(): ClipHistoryStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

let session: ClipSession | null = null;

/** The next clip for this TV session: random, no repeats until the pool is used up. */
export function nextNoraebangClip(pool: readonly PlayableClip[]): PlayableClip | null {
  session ??= createClipSession(sessionStorageOrNull());
  const id = session.next(
    pool.map((clip) => clip.id),
    Math.random,
  );
  return pool.find((clip) => clip.id === id) ?? null;
}
