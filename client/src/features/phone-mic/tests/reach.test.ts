/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONNECT_TIMEOUT_MS,
  PhoneMicSession,
  type PartyListener,
} from '@/features/phone-mic/lib/session';
import { createRig, RESUME_KEY, settle, type Rig } from '@/features/phone-mic/tests/fakes';
import type { ServerToMicParty } from '@/features/remote-mic/protocol';

const live = async (): Promise<[Rig, PhoneMicSession]> => {
  const rig = createRig();
  const session = new PhoneMicSession(rig.ports, 2);
  session.join('Jim');
  await settle();
  rig.sockets.last.accept();
  rig.sockets.last.deliver({
    type: 'assign',
    v: 1,
    slot: 2,
    color: 'fuchsia',
    micId: 'mic-00000001',
    resumeKey: RESUME_KEY,
    reclaimed: false,
    tvConnected: true,
    iceServers: [],
  });
  await settle();
  return [rig, session];
};

/** Moves the clock on while the socket keeps answering pings. */
const advance = async (rig: Rig, ms: number): Promise<void> => {
  if (ms <= 0) {
    return;
  }
  rig.sockets.last.deliver({ type: 'pong', t: rig.clock.now() });
  rig.clock.advance(Math.min(1_000, ms));
  await settle();
  await advance(rig, ms - 1_000);
};

const answerAndTimeOut = async (rig: Rig): Promise<void> => {
  rig.sockets.last.deliver({ type: 'answer', sdp: 'answer' });
  await settle();
  await advance(rig, CONNECT_TIMEOUT_MS);
};

const hostLine = (address: string): string =>
  `a=candidate:1 1 udp 2122260223 ${address} 50000 typ host generation 0`;

void test('two attempts in a row without connected say the TV cannot be reached', async () => {
  const [rig, session] = await live();
  await answerAndTimeOut(rig);
  assert.equal(session.getSnapshot().unreachable, false);
  assert.equal(rig.sockets.last.ofType('offer').length, 2);

  await answerAndTimeOut(rig);
  assert.equal(session.getSnapshot().unreachable, true);
  assert.equal(rig.sockets.last.ofType('offer').length, 2, 'it stops offering until asked');
  const diag = rig.sockets.last.ofType('diag').at(-1);
  assert.equal(
    diag?.data !== undefined && JSON.stringify(diag.data).includes('"unreachable":true'),
    true,
  );
});

void test('a failed ICE restart counts as an attempt', async () => {
  const [rig, session] = await live();
  rig.sockets.last.deliver({ type: 'answer', sdp: 'answer' });
  await settle();
  rig.peer.emit('failed');
  await settle();
  assert.equal(rig.peer.iceRestarts, 1);
  await answerAndTimeOut(rig);
  assert.equal(session.getSnapshot().unreachable, true);
});

void test('Try again and a network change start a fresh attempt; connected clears it', async () => {
  const [rig, session] = await live();
  await answerAndTimeOut(rig);
  await answerAndTimeOut(rig);
  assert.equal(session.getSnapshot().unreachable, true);

  session.retryVoice();
  await settle();
  assert.equal(session.getSnapshot().unreachable, false);
  assert.equal(rig.sockets.last.ofType('offer').length, 3);

  await answerAndTimeOut(rig);
  await answerAndTimeOut(rig);
  assert.equal(session.getSnapshot().unreachable, true);
  rig.network.change('wifi');
  await settle();
  assert.equal(rig.sockets.last.ofType('offer').length, 5);

  rig.peer.emit('connected');
  assert.equal(session.getSnapshot().unreachable, false);
  assert.equal(session.getSnapshot().link, 'live');
});

void test('an attempt that connects resets the count', async () => {
  const [rig, session] = await live();
  await answerAndTimeOut(rig);
  rig.sockets.last.deliver({ type: 'answer', sdp: 'answer' });
  await settle();
  rig.peer.emit('connected');
  rig.peer.emit('disconnected');
  rig.peer.emit('failed');
  await settle();
  assert.equal(session.getSnapshot().unreachable, false, 'one failure after live is not two');
  await answerAndTimeOut(rig);
  assert.equal(session.getSnapshot().unreachable, true, 'the restart did not connect either');
});

void test('only public host addresses, or a cellular connection, hint at mobile data', async () => {
  const rig = createRig();
  rig.peer.offerSdp = () => ['v=0', hostLine('100.64.3.9'), ''].join('\r\n');
  const session = new PhoneMicSession(rig.ports, 2);
  session.join('');
  await settle();
  rig.sockets.last.accept();
  rig.sockets.last.deliver({
    type: 'assign',
    v: 1,
    slot: 2,
    color: 'fuchsia',
    micId: 'mic-00000001',
    resumeKey: RESUME_KEY,
    reclaimed: false,
    tvConnected: true,
    iceServers: [],
  });
  await settle();
  assert.equal(session.getSnapshot().mobileDataHint, true);

  const [lanRig, lanSession] = await live();
  assert.equal(lanSession.getSnapshot().mobileDataHint, false, 'no candidates: no hint');
  lanRig.network.change('cellular');
  await settle();
  assert.equal(lanSession.getSnapshot().mobileDataHint, true);
});

void test('the TV going away is not the Wi-Fi guidance', async () => {
  const [rig, session] = await live();
  await answerAndTimeOut(rig);
  await answerAndTimeOut(rig);
  rig.sockets.last.deliver({ type: 'tv-state', connected: false });
  assert.equal(session.getSnapshot().unreachable, false);
  assert.equal(session.getSnapshot().link, 'waiting-tv');
});

void test('party frames reach the listener; party requests ride on the socket', async () => {
  const [rig, session] = await live();
  const frames: ServerToMicParty[] = [];
  let results = 0;
  let resets = 0;
  const listener: PartyListener = {
    onFrame: (frame) => frames.push(frame),
    onSongResult: () => {
      results += 1;
    },
    onReset: () => {
      resets += 1;
    },
  };
  session.onParty(listener);

  rig.sockets.last.deliver({ type: 'night-rank', rank: 2, entries: 4 });
  rig.sockets.last.deliver({
    type: 'song-result',
    displayScore: 91,
    rawScore: 800,
    tier: 'excellent',
  });
  assert.deepEqual(frames, [{ type: 'night-rank', rank: 2, entries: 4 }]);
  assert.equal(results, 1);

  assert.equal(session.sendParty({ type: 'fx', sound: 'applause' }), true);
  assert.deepEqual(rig.sockets.last.ofType('fx'), [{ type: 'fx', sound: 'applause' }]);

  session.leave();
  assert.equal(resets, 1);
  assert.equal(session.sendParty({ type: 'fx', sound: 'applause' }), false);
});
