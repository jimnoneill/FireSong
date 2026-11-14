/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ACK_TIMEOUT_MS,
  MESSAGE_MS,
  MIX_DRAFT_MS,
  PartyController,
} from '@/features/phone-mic/lib/party-controller';
import {
  calibrateCooldownUntil,
  canStartNow,
  countdownLeft,
  currentSong,
  mixSettings,
  reservationLimits,
  shiftAllowance,
} from '@/features/phone-mic/lib/party-view';
import { FakeClock } from '@/features/phone-mic/tests/fakes';
import { item, snapshot } from '@/features/phone-mic/tests/party-fixtures';
import type { MicPartyToServer, PartySnapshot } from '@/features/remote-mic/protocol';

type Rig = {
  clock: FakeClock;
  sent: MicPartyToServer[];
  party: PartyController;
  online: { up: boolean };
};

const rig = (): Rig => {
  const clock = new FakeClock();
  const sent: MicPartyToServer[] = [];
  const online = { up: true };
  const party = new PartyController({
    send: (frame) => {
      if (online.up) {
        sent.push(frame);
      }
      return online.up;
    },
    timers: clock,
  });
  return { clock, sent, party, online };
};

const deliverSnapshot = (party: PartyController, value: PartySnapshot): void =>
  party.onFrame({ type: 'party', party: value });

void test('reserve sends only the non-default fields and waits for its ack', () => {
  const { party, sent } = rig();
  party.reserve({ fileHash: 'abc', keyOffset: 0, tempo: 1, singNext: true, partners: [3] });

  assert.deepEqual(sent, [
    { type: 'reserve', reqId: 1, fileHash: 'abc', singNext: true, partners: [3] },
  ]);
  assert.equal(party.getSnapshot().pending.length, 1);

  party.onFrame({ type: 'ack', reqId: 1, ok: true, reservationId: 'r1' });
  assert.equal(party.getSnapshot().pending.length, 0);
  assert.equal(party.getSnapshot().messages.length, 0);
});

void test('a refused request shows its code; request ids count up', () => {
  const { party, sent } = rig();
  party.cancel('r1');
  party.control('pause');
  assert.deepEqual(
    sent.map((frame) => ('reqId' in frame ? frame.reqId : null)),
    [1, 2],
  );

  party.onFrame({ type: 'ack', reqId: 2, ok: false, code: 'not-allowed' });
  const [message] = party.getSnapshot().messages;
  assert.deepEqual(message, { id: 1, kind: 'failure', request: 'control', code: 'not-allowed' });
});

void test('no ack within 5 s says it did not reach the TV, and the message fades', () => {
  const { party, clock } = rig();
  party.edit('r1', { singNext: true });

  clock.advance(ACK_TIMEOUT_MS - 1);
  assert.equal(party.getSnapshot().messages.length, 0);
  clock.advance(1);
  assert.deepEqual(
    party.getSnapshot().messages.map((message) => message.kind === 'failure' && message.code),
    ['no-ack'],
  );
  assert.equal(party.getSnapshot().pending.length, 0);

  party.onFrame({ type: 'ack', reqId: 1, ok: false, code: 'busy' });
  assert.equal(party.getSnapshot().messages.length, 1, 'a late ack is ignored');

  clock.advance(MESSAGE_MS);
  assert.equal(party.getSnapshot().messages.length, 0);
});

void test('a request while the socket is down fails at once', () => {
  const { party, online } = rig();
  online.up = false;
  party.calibrate();
  const state = party.getSnapshot();
  assert.deepEqual(state.calibration, { state: 'failed', reason: 'offline' });
  assert.equal(state.pending.length, 0);
});

void test('fun sounds follow the server budget: 3, then one every 2 s', () => {
  const { party, sent, clock } = rig();
  const played = [1, 2, 3, 4, 5].map(() => party.fx('applause'));
  assert.deepEqual(played, [true, true, true, false, false]);
  assert.equal(sent.length, 3);

  clock.advance(1_999);
  assert.equal(party.fx('cheer'), false);
  clock.advance(1);
  assert.equal(party.fx('cheer'), true);
  assert.equal(party.fx('cheer'), false);
  assert.deepEqual(sent.at(-1), { type: 'fx', sound: 'cheer' });
});

void test('mix sends at most 5 frames a second, newest values win', () => {
  const { party, sent, clock } = rig();
  party.mix({ volumePct: 90 });
  party.mix({ volumePct: 80 });
  party.mix({ echoPct: 150 });
  assert.deepEqual(sent, [{ type: 'mix', volumePct: 90 }]);

  clock.advance(200);
  assert.deepEqual(sent.at(-1), { type: 'mix', volumePct: 80, echoPct: 150 });
  assert.equal(sent.length, 2);

  deliverSnapshot(party, snapshot());
  assert.deepEqual(
    mixSettings(party.getSnapshot(), 2),
    { volumePct: 80, echoPct: 150 },
    'the draft beats a stale snapshot',
  );
  clock.advance(MIX_DRAFT_MS);
  assert.deepEqual(mixSettings(party.getSnapshot(), 2), { volumePct: 80, echoPct: 120 });
});

void test('lyric lines arrive as views and clear in the lobby', () => {
  const { party, clock } = rig();
  deliverSnapshot(party, snapshot({ stage: { state: 'singing', singers: [2], title: 'Song 2' } }));
  party.onFrame({
    type: 'lyric',
    line: 'Woo hoo',
    next: 'When I feel heavy metal',
    lineMs: 1_800,
    elapsedMs: 0,
    paused: false,
  });
  assert.deepEqual(party.getSnapshot().lyric, {
    line: 'Woo hoo',
    next: 'When I feel heavy metal',
    lineMs: 1_800,
    elapsedMs: 0,
    paused: false,
    receivedAt: clock.now(),
  });

  party.onFrame({ type: 'lyric', paused: false });
  assert.equal(party.getSnapshot().lyric, null, 'no line clears the card');

  party.onFrame({ type: 'lyric', line: 'Again', paused: true });
  deliverSnapshot(party, snapshot());
  assert.equal(party.getSnapshot().lyric, null, 'the lobby clears the card');
});

void test('calibration frames drive the tune state and its 30 s cooldown', () => {
  const { party, clock } = rig();
  party.calibrate();
  assert.deepEqual(party.getSnapshot().calibration, { state: 'requested' });
  party.onFrame({ type: 'ack', reqId: 1, ok: true });
  party.onFrame({ type: 'calibration', state: 'started' });
  assert.deepEqual(party.getSnapshot().calibration, { state: 'started' });
  party.onFrame({ type: 'calibration', state: 'done', latencyMs: 212 });
  assert.deepEqual(party.getSnapshot().calibration, { state: 'done', latencyMs: 212 });

  assert.notEqual(calibrateCooldownUntil(party.getSnapshot(), clock.now() + 29_999), null);
  assert.equal(calibrateCooldownUntil(party.getSnapshot(), clock.now() + 30_000), null);

  party.onFrame({ type: 'calibration', state: 'failed', reason: 'no-tone' });
  assert.deepEqual(party.getSnapshot().calibration, { state: 'failed', reason: 'no-tone' });
});

void test('notices and night ranks; a new song result clears the old rank', () => {
  const { party } = rig();
  party.onFrame({ type: 'notice', code: 'duet-added', title: 'Creep', bySlot: 1 });
  assert.deepEqual(party.getSnapshot().messages, [
    { id: 1, kind: 'notice', code: 'duet-added', title: 'Creep', bySlot: 1 },
  ]);

  party.onFrame({ type: 'night-rank', rank: 2, entries: 5 });
  assert.deepEqual(party.getSnapshot().nightRank, { rank: 2, entries: 5 });
  party.onSongResult();
  assert.equal(party.getSnapshot().nightRank, null);
  party.onFrame({ type: 'night-rank', entries: 12 });
  assert.deepEqual(party.getSnapshot().nightRank, { entries: 12 });
});

void test('the current song keeps its key and tempo after it left the queue', () => {
  const { party, sent, clock } = rig();
  deliverSnapshot(
    party,
    snapshot({
      queue: [item({ reservationId: 'r3', singers: [2], keyOffset: -2, tempo: 0.9 })],
      queueTotal: 1,
    }),
  );
  deliverSnapshot(
    party,
    snapshot({ stage: { state: 'singing', reservationId: 'r3', title: 'Song r3', singers: [2] } }),
  );

  assert.deepEqual(currentSong(party.getSnapshot()), {
    title: 'Song r3',
    shiftable: true,
    settings: { keyOffset: -2, tempo: 0.9 },
  });

  party.shiftCurrent({ keyOffset: 1, tempo: 1 });
  assert.deepEqual(sent.at(-1), { type: 'shift-current', reqId: 1, keyOffset: 1, tempo: 1 });
  party.onFrame({ type: 'ack', reqId: 1, ok: true });
  assert.deepEqual(currentSong(party.getSnapshot())?.settings, { keyOffset: 1, tempo: 1 });
  assert.equal(shiftAllowance(party.getSnapshot(), clock.now()).kind, 'cooldown');
  assert.equal(shiftAllowance(party.getSnapshot(), clock.now() + 15_000).kind, 'ok');
});

void test('three accepted shifts use up the song', () => {
  const { party, clock } = rig();
  deliverSnapshot(
    party,
    snapshot({ stage: { state: 'singing', reservationId: 'r3', singers: [2] } }),
  );
  for (let reqId = 1; reqId <= 3; reqId += 1) {
    party.shiftCurrent({ keyOffset: reqId, tempo: 1 });
    party.onFrame({ type: 'ack', reqId, ok: true });
    clock.advance(15_000);
  }
  assert.equal(shiftAllowance(party.getSnapshot(), clock.now()).kind, 'used-up');

  deliverSnapshot(
    party,
    snapshot({ stage: { state: 'singing', reservationId: 'r4', singers: [2] } }),
  );
  assert.equal(
    shiftAllowance(party.getSnapshot(), clock.now()).kind,
    'ok',
    'a new song starts fresh',
  );
});

void test('start now is offered to the singers of the first ready item only', () => {
  const queue = [
    item({ reservationId: 'r1', singers: [3], prep: { state: 'analyzing', pct: 40 } }),
    item({ reservationId: 'r2', singers: [2, 1] }),
  ];
  const value = snapshot({
    queue,
    queueTotal: 2,
    stage: { state: 'lobby', singers: [], countdownSecs: 12 },
  });
  assert.equal(canStartNow(value, 2), true);
  assert.equal(canStartNow(value, 1), true, 'a partner sings it too');
  assert.equal(canStartNow(value, 3), false, 'a preparing item never holds up a ready one');
  assert.equal(canStartNow({ ...value, stage: { state: 'singing', singers: [1] } }, 2), false);
});

void test('the lobby countdown runs on from the snapshot', () => {
  const { party, clock } = rig();
  deliverSnapshot(party, snapshot({ stage: { state: 'lobby', singers: [], countdownSecs: 12 } }));
  assert.equal(countdownLeft(party.getSnapshot(), clock.now()), 12);
  assert.equal(countdownLeft(party.getSnapshot(), clock.now() + 2_500), 10);
  assert.equal(countdownLeft(party.getSnapshot(), clock.now() + 60_000), 0);
});

void test('reservation limits mirror the server: owned, preparing and sing next', () => {
  const queue = [
    item({ reservationId: 'r1', singers: [2], singNext: true }),
    item({ reservationId: 'r2', singers: [2], prep: { state: 'queued', etaSecs: 120 } }),
    item({ reservationId: 'r3', singers: [2, 1], prep: { state: 'analyzing' } }),
    item({ reservationId: 'r4', singers: [1, 2] }),
  ];
  assert.deepEqual(reservationLimits(snapshot({ queue }), 2), {
    owned: 3,
    preparing: 2,
    singNext: 1,
    canReserve: false,
    canPrepare: false,
    canSingNext: false,
  });
  assert.equal(reservationLimits(snapshot({ queue }), 1).owned, 1);
});

void test('leaving resets the party state', () => {
  const { party } = rig();
  deliverSnapshot(party, snapshot());
  party.onFrame({ type: 'night-rank', rank: 1, entries: 1 });
  party.onReset();
  assert.equal(party.getSnapshot().snapshot, null);
  assert.equal(party.getSnapshot().nightRank, null);
});
