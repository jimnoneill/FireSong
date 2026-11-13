/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PhoneMicSession } from '@/features/phone-mic/lib/session';
import { CLIENT_TIMEOUT_CLOSE, PONG_TIMEOUT_MS } from '@/features/phone-mic/lib/signaling';
import { createRig, RESUME_KEY, settle, type Rig } from '@/features/phone-mic/tests/fakes';
import { CLOSE_CODE, MIC_IDENTITY_STORAGE_KEY, type MicSlot } from '@/features/remote-mic/protocol';

const joined = async (linkSlot: MicSlot | null = 2): Promise<[Rig, PhoneMicSession]> => {
  const rig = createRig();
  const session = new PhoneMicSession(rig.ports, linkSlot);
  session.join('  Jim  ');
  await settle();
  rig.sockets.last.accept();
  return [rig, session];
};

const assign = (rig: Rig, tvConnected = true, reclaimed = false): void => {
  rig.sockets.last.deliver({
    type: 'assign',
    v: 1,
    slot: 2,
    color: 'fuchsia',
    micId: 'mic-00000001',
    resumeKey: RESUME_KEY,
    reclaimed,
    tvConnected,
    iceServers: [],
  });
};

void test('join captures first, then says hello with the QR slot and name', async () => {
  const [rig, session] = await joined();

  assert.equal(rig.media.starts, 1);
  assert.equal(rig.sockets.last.url, 'wss://phone.example/rtc');
  assert.deepEqual(rig.sockets.last.ofType('hello'), [
    { type: 'hello', v: 1, micId: 'mic-00000001', slot: 2, name: 'Jim' },
  ]);
  assert.equal(session.getSnapshot().stage, 'joined');
  assert.equal(rig.wakeLock.acquires, 1);
});

void test('a denied microphone stays on the join card and opens no socket', async () => {
  const rig = createRig();
  rig.media.startResult = 'denied';
  const session = new PhoneMicSession(rig.ports, 1);

  session.join('');
  await settle();

  assert.equal(session.getSnapshot().stage, 'idle');
  assert.equal(session.getSnapshot().problem, 'mic-denied');
  assert.equal(rig.sockets.opened.length, 0);
});

void test('assign stores the identity and offers to a connected TV', async () => {
  const [rig, session] = await joined();
  assign(rig);
  await settle();

  const stored = rig.storage.data.get(MIC_IDENTITY_STORAGE_KEY) ?? '';
  assert.deepEqual(JSON.parse(stored), { micId: 'mic-00000001', resumeKey: RESUME_KEY, slot: 2 });
  assert.deepEqual(rig.sockets.last.ofType('offer'), [
    { type: 'offer', sdp: 'offer-1', restart: false },
  ]);
  assert.equal(session.getSnapshot().slot, 2);
  assert.equal(session.getSnapshot().link, 'connecting');

  rig.peer.emit('connected');
  await settle();
  assert.equal(session.getSnapshot().link, 'live');
  assert.equal(rig.sockets.last.ofType('diag').length, 1);
});

void test('without a TV the phone waits, then offers on tv-state', async () => {
  const [rig, session] = await joined();
  assign(rig, false);
  await settle();

  assert.equal(session.getSnapshot().link, 'waiting-tv');
  assert.equal(rig.sockets.last.ofType('offer').length, 0);

  rig.sockets.last.deliver({ type: 'tv-state', connected: true });
  await settle();
  assert.equal(rig.sockets.last.ofType('offer').length, 1);

  rig.sockets.last.deliver({ type: 'tv-state', connected: false });
  await settle();
  assert.equal(session.getSnapshot().link, 'waiting-tv');
  assert.ok(rig.peer.closes >= 1);
});

void test('answers and TV candidates go to the peer connection', async () => {
  const [rig] = await joined();
  assign(rig);
  await settle();

  rig.sockets.last.deliver({ type: 'answer', sdp: 'answer-sdp' });
  rig.sockets.last.deliver({ type: 'ice', candidate: null });
  await settle();

  assert.deepEqual(rig.peer.answers, ['answer-sdp']);
  assert.deepEqual(rig.peer.candidates, [null]);
});

void test('a rejected answer starts a fresh session after a second', async () => {
  const [rig] = await joined();
  assign(rig);
  await settle();
  rig.peer.answerOutcome = 'failed';

  rig.sockets.last.deliver({ type: 'answer', sdp: 'bad' });
  await settle();
  rig.clock.advance(1_000);
  await settle();

  assert.deepEqual(
    rig.sockets.last.ofType('offer').map((frame) => frame.sdp),
    ['offer-1', 'offer-2'],
  );
});

void test('ICE failure and TV restart requests send restart offers', async () => {
  const [rig, session] = await joined();
  assign(rig);
  await settle();

  rig.peer.emit('failed');
  await settle();
  rig.sockets.last.deliver({ type: 'restart' });
  await settle();

  assert.deepEqual(rig.sockets.last.ofType('offer').slice(1), [
    { type: 'offer', sdp: 'restart-1', restart: true },
    { type: 'offer', sdp: 'restart-2', restart: true },
  ]);
  assert.equal(session.getSnapshot().link, 'connecting');
});

void test('mute goes to the server; a host mute is applied and labelled', async () => {
  const [rig, session] = await joined();
  assign(rig);
  await settle();

  session.toggleMute();
  assert.deepEqual(rig.sockets.last.ofType('mute'), [{ type: 'mute', muted: true }]);
  assert.equal(rig.media.enabled, false);

  rig.sockets.last.deliver({ type: 'mute', muted: false, by: 'mic' });
  rig.sockets.last.deliver({ type: 'mute', muted: true, by: 'tv' });
  assert.equal(session.getSnapshot().mutedBy, 'tv');
  assert.equal(rig.media.enabled, false);
});

void test('a mute made while offline is sent after the next assign', async () => {
  const [rig, session] = await joined();
  rig.sockets.last.drop(1006);
  session.toggleMute();
  rig.clock.advance(1_000);
  rig.sockets.last.accept();
  assign(rig, true, true);
  await settle();

  assert.deepEqual(rig.sockets.last.ofType('mute'), [{ type: 'mute', muted: true }]);
});

void test('a lost track is replaced in place without renegotiating', async () => {
  const [rig, session] = await joined();
  assign(rig);
  await settle();
  rig.peer.emit('connected');
  await settle();

  rig.media.fireTrouble();
  await settle();

  assert.equal(rig.media.restarts, 1);
  assert.equal(rig.peer.trackSwaps, 1);
  assert.equal(rig.sockets.last.ofType('offer').length, 1);
  assert.equal(session.getSnapshot().needsTap, false);
  const recovered = rig.sockets.last.ofType('diag').at(-1);
  assert.equal(recovered?.data !== undefined, true);
});

void test('recovery waits while hidden and runs once the page is shown', async () => {
  const [rig] = await joined();
  assign(rig);
  await settle();

  rig.page.hide();
  rig.media.fireTrouble();
  await settle();
  assert.equal(rig.media.restarts, 0);

  rig.page.show();
  rig.clock.advance(500);
  await settle();
  assert.equal(rig.media.restarts, 1);
  assert.equal(rig.peer.trackSwaps, 1);
  assert.equal(rig.wakeLock.acquires, 2);
});

void test('a recovery that needs a gesture shows the rejoin banner until tapped', async () => {
  const [rig, session] = await joined();
  assign(rig);
  await settle();

  rig.media.restartResult = 'denied';
  rig.media.fireTrouble();
  await settle();
  assert.equal(session.getSnapshot().needsTap, true);

  rig.media.restartResult = 'ok';
  session.tapToResume();
  await settle();
  assert.equal(session.getSnapshot().needsTap, false);
  assert.equal(rig.peer.trackSwaps, 1);
});

void test('a dropped socket reconnects with the same micId, resumeKey and slot', async () => {
  const [rig, session] = await joined();
  assign(rig);
  await settle();

  rig.sockets.last.drop(1006);
  assert.equal(session.getSnapshot().link, 'offline');
  assert.equal(rig.sockets.opened.length, 1);

  rig.clock.advance(600);
  assert.equal(rig.sockets.opened.length, 2);
  rig.sockets.last.accept();
  assert.deepEqual(rig.sockets.last.ofType('hello'), [
    { type: 'hello', v: 1, micId: 'mic-00000001', resumeKey: RESUME_KEY, slot: 2, name: 'Jim' },
  ]);
});

void test('a silent socket is closed after the pong timeout and reconnected', async () => {
  const [rig] = await joined();
  rig.clock.advance(PONG_TIMEOUT_MS + 5_000);

  assert.equal(rig.sockets.opened[0]?.closedWith, CLIENT_TIMEOUT_CLOSE);
  assert.ok((rig.sockets.opened[0]?.ofType('ping').length ?? 0) >= 2);
  rig.clock.advance(1_000);
  assert.equal(rig.sockets.opened.length, 2);
});

for (const [code, reason] of [
  [CLOSE_CODE.replaced, 'replaced'],
  [CLOSE_CODE.kicked, 'kicked'],
  [CLOSE_CODE.badRequest, 'bad-request'],
] as const) {
  void test(`close ${code} (${reason}) stops the mic until the user rejoins`, async () => {
    const [rig, session] = await joined();
    assign(rig);
    await settle();

    rig.sockets.last.drop(code);
    rig.clock.advance(60_000);

    assert.equal(session.getSnapshot().stage, 'ended');
    assert.equal(session.getSnapshot().problem, reason);
    assert.equal(rig.sockets.opened.length, 1);
    assert.equal(rig.media.stops, 1);

    session.rejoin();
    await settle();
    assert.equal(rig.sockets.opened.length, 2);
  });
}

void test('bad-resume drops the identity and reconnects at once with a new micId', async () => {
  const [rig] = await joined();
  rig.storage.set(
    MIC_IDENTITY_STORAGE_KEY,
    JSON.stringify({ micId: 'mic-00000001', resumeKey: RESUME_KEY, slot: 2 }),
  );

  rig.sockets.last.drop(CLOSE_CODE.badResume);
  assert.equal(rig.sockets.opened.length, 2);
  rig.sockets.last.accept();
  assert.deepEqual(rig.sockets.last.ofType('hello'), [
    { type: 'hello', v: 1, micId: 'mic-00000002', slot: 2, name: 'Jim' },
  ]);
});

void test('slots-full shows the problem and retries every 5 s', async () => {
  const [rig, session] = await joined();
  rig.sockets.last.deliver({ type: 'error', code: 'slots-full' });
  rig.sockets.last.drop(CLOSE_CODE.slotsFull);

  assert.equal(session.getSnapshot().problem, 'slots-full');
  rig.clock.advance(4_999);
  assert.equal(rig.sockets.opened.length, 1);
  rig.clock.advance(1);
  assert.equal(rig.sockets.opened.length, 2);

  rig.sockets.last.accept();
  assign(rig);
  assert.equal(session.getSnapshot().problem, null);
});

void test('the song result is shown until dismissed', async () => {
  const [rig, session] = await joined();
  assign(rig);
  rig.sockets.last.deliver({
    type: 'song-result',
    displayScore: 93,
    rawScore: 720,
    tier: 'excellent',
    rank: 1,
    singers: 2,
    title: 'Song',
  });

  assert.deepEqual(session.getSnapshot().result, {
    displayScore: 93,
    rawScore: 720,
    tier: 'excellent',
    rank: 1,
    singers: 2,
    title: 'Song',
  });
  session.dismissResult();
  assert.equal(session.getSnapshot().result, null);
});

void test('leave says bye, closes the socket and releases the mic', async () => {
  const [rig, session] = await joined();
  assign(rig);
  await settle();

  session.leave();

  assert.equal(rig.sockets.last.ofType('bye').length, 1);
  assert.equal(rig.sockets.last.closedWith, 1000);
  assert.equal(rig.media.stops, 1);
  assert.equal(rig.wakeLock.releases, 1);
  assert.equal(session.getSnapshot().stage, 'idle');
  rig.clock.advance(60_000);
  assert.equal(rig.sockets.opened.length, 1);
});

void test('a lost wake lock is taken again when the page is shown', async () => {
  const [rig, session] = await joined();
  await settle();
  assert.equal(session.getSnapshot().wakeLock, 'held');

  rig.wakeLock.systemRelease();
  assert.equal(session.getSnapshot().wakeLock, 'idle');
  rig.page.restoreFromCache();
  await settle();
  assert.equal(session.getSnapshot().wakeLock, 'held');
  assert.equal(rig.wakeLock.acquires, 2);
});
