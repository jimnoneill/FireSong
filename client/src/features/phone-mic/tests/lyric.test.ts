/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { graphemes, litCount, lyricProgress } from '@/features/phone-mic/lib/lyric';
import type { LyricView } from '@/features/phone-mic/lib/party-state';

const line = (patch: Partial<LyricView> = {}): LyricView => ({
  line: 'Woo hoo',
  lineMs: 2_000,
  elapsedMs: 500,
  paused: false,
  receivedAt: 10_000,
  ...patch,
});

void test('the wipe runs on from the frame elapsed time with the wall clock', () => {
  assert.equal(lyricProgress(line(), 10_000), 0.25);
  assert.equal(lyricProgress(line(), 10_500), 0.5);
  assert.equal(lyricProgress(line(), 20_000), 1);
});

void test('the wipe is frozen while paused', () => {
  assert.equal(lyricProgress(line({ paused: true }), 10_000), 0.25);
  assert.equal(lyricProgress(line({ paused: true }), 15_000), 0.25);
});

void test('a line without a length has no wipe', () => {
  assert.equal(lyricProgress(line({ lineMs: undefined }), 10_000), null);
  assert.equal(lyricProgress(line({ lineMs: 0 }), 10_000), null);
});

void test('the wipe lights whole characters, Hangul syllables and emoji included', () => {
  assert.deepEqual(graphemes('노래방🎤'), ['노', '래', '방', '🎤']);
  assert.equal(litCount(4, 0.5), 2);
  assert.equal(litCount(4, 1.2), 4);
  assert.equal(litCount(4, -1), 0);
});
