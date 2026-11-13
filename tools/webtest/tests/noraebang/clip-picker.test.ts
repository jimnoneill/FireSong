import { describe, expect, it } from 'vitest';

import { createClipSession, pickNextClip } from '@/features/noraebang/clip-picker';

import { seededRandom } from './random';

const POOL = ['beach', 'balloon', 'blossom', 'fireworks', 'dolphins', 'neon'];

function drawMany(pool: readonly string[], count: number, seed: number): string[] {
  const random = seededRandom(seed);
  let history: string[] = [];
  const picks: string[] = [];
  for (let index = 0; index < count; index++) {
    const pick = pickNextClip(pool, history, random);
    if (pick === null) {
      throw new Error('empty pick');
    }
    picks.push(pick.id);
    history = pick.history;
  }
  return picks;
}

describe('clip picker', () => {
  it('plays every clip once before any repeats', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const picks = drawMany(POOL, POOL.length * 3, seed);
      for (let cycle = 0; cycle < 3; cycle++) {
        const window = picks.slice(cycle * POOL.length, (cycle + 1) * POOL.length);
        expect(new Set(window).size, `seed ${seed} cycle ${cycle}`).toBe(POOL.length);
      }
    }
  });

  it('never shows the same clip twice in a row across a cycle boundary', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const picks = drawMany(POOL.slice(0, 3), 30, seed);
      picks.slice(1).forEach((id, index) => {
        expect(id, `seed ${seed} pick ${index + 1}`).not.toBe(picks[index]);
      });
    }
  });

  it('is random: different seeds give different orders', () => {
    const orders = new Set(
      Array.from({ length: 20 }, (_, seed) => drawMany(POOL, POOL.length, seed + 1).join()),
    );
    expect(orders.size).toBeGreaterThan(10);
  });

  it('repeats a single clip and returns null for an empty pool', () => {
    expect(drawMany(['only'], 3, 7)).toEqual(['only', 'only', 'only']);
    expect(pickNextClip([], ['old'], Math.random)).toBeNull();
  });

  it('ignores history entries that left the pool and duplicate pool ids', () => {
    const pick = pickNextClip(['a', 'a', 'b'], ['gone', 'a'], () => 0);
    expect(pick).toEqual({ id: 'b', history: ['a', 'b'] });
  });

  it('keeps picks in range for odd random values', () => {
    for (const roll of [1, 1.5, -0.2, Number.NaN]) {
      const pick = pickNextClip(POOL, [], () => roll);
      expect(POOL).toContain(pick?.id);
    }
  });
});

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('clip session', () => {
  it('remembers played clips across a reload of the same tab', () => {
    const storage = new MemoryStorage();
    const random = seededRandom(3);
    const first = createClipSession(storage);
    const played = [first.next(POOL, random), first.next(POOL, random), first.next(POOL, random)];

    const reloaded = createClipSession(storage);
    expect(reloaded.history()).toEqual(played);
    const rest = Array.from({ length: POOL.length - 3 }, () => reloaded.next(POOL, random));
    expect(new Set([...played, ...rest]).size).toBe(POOL.length);
  });

  it('works without storage and survives broken or throwing storage', () => {
    const random = seededRandom(9);
    expect(createClipSession(null).next(POOL, random)).not.toBeNull();

    const garbled = new MemoryStorage();
    garbled.setItem('firesong.noraebang.clip-history', '{"not":"a list"}');
    expect(createClipSession(garbled).history()).toEqual([]);

    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const session = createClipSession(throwing);
    expect(session.next(POOL, random)).not.toBeNull();
    expect(session.history()).toHaveLength(1);
  });
});
