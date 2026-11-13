import { describe, expect, it, vi } from 'vitest';

import { diagEnabled } from '@/features/remote-mic/diag';

vi.mock('@/i18n', () => ({ t: (key: string) => key }));

const memoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
};

describe('TV diagnostics flag', () => {
  it('is off unless the page asked for it, and sticks for the session', () => {
    const storage = memoryStorage();
    expect(diagEnabled('', storage)).toBe(false);
    expect(diagEnabled('?tv=1&fsdiag=1', storage)).toBe(true);
    expect(diagEnabled('', storage)).toBe(true);
    expect(diagEnabled('?fsdiag=0', storage)).toBe(false);
    expect(diagEnabled('', storage)).toBe(false);
  });

  it('still honours the query without session storage', () => {
    expect(diagEnabled('?fsdiag=1', null)).toBe(true);
    expect(diagEnabled('', null)).toBe(false);
  });
});
