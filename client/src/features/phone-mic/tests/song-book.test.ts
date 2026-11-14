/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fetchSongBookPage,
  normalizeSearch,
  SEARCH_DEBOUNCE_MS,
  SONG_BOOK_PAGE_SIZE,
  SONG_BOOK_PATH,
  SongBook,
  type HttpPost,
} from '@/features/phone-mic/lib/song-book';
import { FakeClock, settle } from '@/features/phone-mic/tests/fakes';
import type { BookSong, SongBookQuery } from '@/features/remote-mic/protocol';

const song = (index: number, ready: boolean): BookSong => ({
  fileHash: `hash-${String(index)}`,
  title: `Song ${String(index)}`,
  artist: 'Artist',
  durationSecs: 180,
  shiftable: true,
  prep: ready ? { state: 'ready' } : { state: 'not-ready', etaSecs: 150 },
});

const LIBRARY = Array.from({ length: 60 }, (_, index) => song(index, index < 40));

type Call = {
  path: string;
  query: SongBookQuery;
  resolve: (status: number, body?: unknown) => void;
};

const nth = (calls: readonly Call[], index: number): Call => {
  const call = calls.at(index);
  if (call === undefined) {
    throw new Error(`no request ${String(index)}`);
  }
  return call;
};

const isQuery = (value: unknown): value is SongBookQuery =>
  typeof value === 'object' && value !== null && 'take' in value;

const fakeServer = () => {
  const calls: Call[] = [];
  const post: HttpPost = (path, body) =>
    new Promise((resolveResponse) => {
      const query: unknown = JSON.parse(body);
      if (!isQuery(query)) {
        throw new TypeError(body);
      }
      calls.push({
        path,
        query,
        resolve: (status, json) => resolveResponse({ status, json: () => Promise.resolve(json) }),
      });
    });
  const page = (query: SongBookQuery) => ({
    items: LIBRARY.slice(query.skip, query.skip + query.take),
    skip: query.skip,
    total: LIBRARY.length,
    readyTotal: 40,
  });
  return { calls, post, page };
};

void test('the song book posts the query and validates the page', async () => {
  const server = fakeServer();
  const result = fetchSongBookPage(server.post, { search: 'blur', skip: 0, take: 25 });
  const call = nth(server.calls, 0);
  assert.equal(call.path, SONG_BOOK_PATH);
  assert.equal(SONG_BOOK_PATH, '/api/cmd/firesong_song_book');
  assert.deepEqual(call.query, { search: 'blur', skip: 0, take: 25 });
  call.resolve(200, server.page(call.query));
  const settled = await result;
  assert.equal(settled.kind, 'ok');
});

void test('401 means the link expired; other errors and bad pages fail', async () => {
  const server = fakeServer();
  const expired = fetchSongBookPage(server.post, { skip: 0, take: 25 });
  nth(server.calls, 0).resolve(401);
  assert.deepEqual(await expired, { kind: 'expired' });

  const broken = fetchSongBookPage(server.post, { skip: 0, take: 25 });
  nth(server.calls, 1).resolve(200, { items: 'nope' });
  assert.equal((await broken).kind, 'failed');

  const forbidden = fetchSongBookPage(server.post, { skip: 0, take: 25 });
  nth(server.calls, 2).resolve(403);
  assert.equal((await forbidden).kind, 'failed');

  const offline = await fetchSongBookPage(() => Promise.reject(new TypeError('network')), {
    skip: 0,
    take: 25,
  });
  assert.equal(offline.kind, 'failed');
});

void test('search text is trimmed and cut to 100 characters', () => {
  assert.equal(normalizeSearch('  '), undefined);
  assert.equal(normalizeSearch('  creep '), 'creep');
  assert.equal(normalizeSearch('é'.repeat(150))?.length, 100);
});

void test('the book loads 25 at a time and appends the next page', async () => {
  const server = fakeServer();
  const errors: unknown[] = [];
  const book = new SongBook({
    post: server.post,
    timers: new FakeClock(),
    reportError: (error) => errors.push(error),
  });

  book.open();
  assert.equal(book.getSnapshot().status, 'loading');
  assert.deepEqual(nth(server.calls, 0).query, { skip: 0, take: SONG_BOOK_PAGE_SIZE });
  nth(server.calls, 0).resolve(200, server.page({ skip: 0, take: 25 }));
  await settle();
  assert.equal(book.getSnapshot().items.length, 25);
  assert.equal(book.getSnapshot().readyTotal, 40);

  book.loadMore();
  book.loadMore();
  assert.equal(server.calls.length, 2, 'one next-page request at a time');
  nth(server.calls, 1).resolve(200, server.page({ skip: 25, take: 25 }));
  await settle();
  assert.equal(book.getSnapshot().items.length, 50);
  assert.equal(errors.length, 0);
});

void test('typing waits 250 ms and drops answers to older searches', async () => {
  const server = fakeServer();
  const clock = new FakeClock();
  const book = new SongBook({ post: server.post, timers: clock, reportError: () => undefined });
  book.open();

  book.setText('cr');
  book.setText('cre');
  clock.advance(SEARCH_DEBOUNCE_MS - 1);
  assert.equal(server.calls.length, 1);
  book.setText('creep');
  clock.advance(SEARCH_DEBOUNCE_MS);
  assert.equal(server.calls.length, 2);
  assert.deepEqual(nth(server.calls, 1).query, { skip: 0, take: 25, search: 'creep' });

  nth(server.calls, 0).resolve(200, server.page({ skip: 0, take: 25 }));
  await settle();
  assert.equal(book.getSnapshot().status, 'loading', 'the stale first page is dropped');

  nth(server.calls, 1).resolve(200, { items: [song(7, false)], skip: 0, total: 1, readyTotal: 0 });
  await settle();
  assert.deepEqual(
    book.getSnapshot().items.map((each) => each.fileHash),
    ['hash-7'],
  );
  assert.equal(book.getSnapshot().text, 'creep');
});

void test('a failed next page can be retried without losing the list', async () => {
  const server = fakeServer();
  const book = new SongBook({
    post: server.post,
    timers: new FakeClock(),
    reportError: () => undefined,
  });
  book.open();
  nth(server.calls, 0).resolve(200, server.page({ skip: 0, take: 25 }));
  await settle();

  book.loadMore();
  nth(server.calls, 1).resolve(500);
  await settle();
  assert.equal(book.getSnapshot().moreFailed, true);
  assert.equal(book.getSnapshot().items.length, 25);

  book.retry();
  assert.deepEqual(nth(server.calls, 2).query, { skip: 25, take: 25 });
});
