import { describe, expect, it } from 'vitest';

import { parseFireSongLaunch } from '@/bridge/firesong-launch';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key() {
    return null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe('parseFireSongLaunch', () => {
  it('reads the TV and noraebang flags from the launch URL', () => {
    const storage = new MemoryStorage();
    expect(parseFireSongLaunch('?tv=1&mode=noraebang', storage)).toEqual({
      tv: true,
      noraebang: true,
      nativeVoice: false,
    });
    expect(parseFireSongLaunch('?tv=1&voice=native', storage)).toMatchObject({ nativeVoice: true });
    expect(parseFireSongLaunch('?tv=0', storage)).toEqual({ tv: false, noraebang: false, nativeVoice: false });
  });

  it('keeps the flags for the session after the SPA drops the query', () => {
    const storage = new MemoryStorage();
    parseFireSongLaunch('?tv=1', storage);
    expect(parseFireSongLaunch('', storage)).toEqual({ tv: true, noraebang: false, nativeVoice: false });
    expect(parseFireSongLaunch('?song=1', storage)).toEqual({ tv: true, noraebang: false, nativeVoice: false });
  });

  it('defaults to a plain browser without flags or storage', () => {
    expect(parseFireSongLaunch('', null)).toEqual({ tv: false, noraebang: false, nativeVoice: false });
    expect(parseFireSongLaunch('?tv=1', null)).toEqual({ tv: true, noraebang: false, nativeVoice: false });
  });
});
