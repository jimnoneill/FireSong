/**
 * Picks background clips at random without repeating one until the whole
 * pool has played, across songs of one TV session.
 *
 * `history` lists the clip ids of the current cycle, oldest first. When every
 * clip in the pool has played, a new cycle starts; its first pick avoids the
 * clip that just played, so the same clip never shows twice in a row unless
 * the pool has a single clip.
 */

export type ClipPick = {
  id: string;
  /** History to keep for the next pick. */
  history: string[];
};

export function pickNextClip(
  poolIds: readonly string[],
  history: readonly string[],
  random: () => number,
): ClipPick | null {
  const pool = [...new Set(poolIds)];
  if (pool.length === 0) {
    return null;
  }

  const inPool = new Set(pool);
  const cycle = history.filter((id) => inPool.has(id));
  const played = new Set(cycle);
  const fresh = pool.filter((id) => !played.has(id));
  if (fresh.length > 0) {
    const id = pickOne(fresh, random);
    return { id, history: [...cycle, id] };
  }

  const last = cycle.at(-1);
  const candidates = pool.length > 1 ? pool.filter((id) => id !== last) : pool;
  const id = pickOne(candidates, random);
  return { id, history: [id] };
}

function pickOne(candidates: readonly string[], random: () => number): string {
  const roll = random();
  const unit = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 1 - Number.EPSILON) : 0;
  return candidates[Math.floor(unit * candidates.length)];
}

export type ClipHistoryStorage = Pick<Storage, 'getItem' | 'setItem'>;

const HISTORY_STORAGE_KEY = 'firesong.noraebang.clip-history';
const MAX_STORED_HISTORY = 1000;

/**
 * Session memory of played clips. It survives a page reload in the same tab
 * (sessionStorage), which is what a WebView renderer restart looks like.
 */
export function createClipSession(storage: ClipHistoryStorage | null) {
  let history = readHistory(storage);

  return {
    next(poolIds: readonly string[], random: () => number): string | null {
      const pick = pickNextClip(poolIds, history, random);
      if (pick === null) {
        return null;
      }
      history = pick.history.slice(-MAX_STORED_HISTORY);
      writeHistory(storage, history);
      return pick.id;
    },
    history(): readonly string[] {
      return history;
    },
  };
}

export type ClipSession = ReturnType<typeof createClipSession>;

function readHistory(storage: ClipHistoryStorage | null): string[] {
  try {
    const raw = storage?.getItem(HISTORY_STORAGE_KEY) ?? null;
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeHistory(storage: ClipHistoryStorage | null, history: readonly string[]): void {
  try {
    storage?.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Storage unavailable: the in-memory history still avoids repeats.
  }
}
