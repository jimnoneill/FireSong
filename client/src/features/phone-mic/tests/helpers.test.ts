/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ensureMicIdentity,
  normalizeSingerName,
  preferredSlot,
  readMicIdentity,
  readSingerName,
  writeSingerName,
} from '@/features/phone-mic/lib/identity';
import {
  joinLinkSlot,
  rtcSocketUrl,
  urlWithoutPairingToken,
} from '@/features/phone-mic/lib/join-link';
import { meterFraction, nextMeterLevel, rms } from '@/features/phone-mic/lib/meter-math';
import {
  BACKOFF_STEPS_MS,
  backoffDelayMs,
  decideOnClose,
  SLOTS_FULL_RETRY_MS,
} from '@/features/phone-mic/lib/reconnect';
import { isPhoneMicPath } from '@/features/phone-mic/route';
import { memoryStore, RESUME_KEY } from '@/features/phone-mic/tests/fakes';
import { CLOSE_CODE, MIC_IDENTITY_STORAGE_KEY } from '@/features/remote-mic/protocol';

void test('only /m and /m/ are the phone mic page', () => {
  assert.equal(isPhoneMicPath('/m'), true);
  assert.equal(isPhoneMicPath('/m/'), true);
  assert.equal(isPhoneMicPath('/'), false);
  assert.equal(isPhoneMicPath('/q'), false);
  assert.equal(isPhoneMicPath('/mm'), false);
});

void test('the QR slot must be exactly 1-4', () => {
  assert.equal(joinLinkSlot('?t=abc&slot=3'), 3);
  for (const bad of ['', '?slot=0', '?slot=5', '?slot=2.0', '?slot= 2', '?slot=two']) {
    assert.equal(joinLinkSlot(bad), null, bad);
  }
});

void test('the pairing token is removed from the URL, the slot kept', () => {
  assert.equal(
    urlWithoutPairingToken('https://phone.example:8443/m?t=secret&slot=2'),
    'https://phone.example:8443/m?slot=2',
  );
  assert.equal(urlWithoutPairingToken('https://phone.example/m?slot=2'), null);
});

void test('the socket follows the page scheme', () => {
  assert.equal(
    rtcSocketUrl({ protocol: 'https:', host: 'a.example:8443' }),
    'wss://a.example:8443/rtc',
  );
  assert.equal(rtcSocketUrl({ protocol: 'http:', host: 'localhost:5' }), 'ws://localhost:5/rtc');
});

void test('stored identities are validated before use', () => {
  const store = memoryStore();
  const read = (value: string) => {
    store.set(MIC_IDENTITY_STORAGE_KEY, value);
    return readMicIdentity(store);
  };

  assert.deepEqual(read(JSON.stringify({ micId: 'mic-12345', resumeKey: RESUME_KEY, slot: 4 })), {
    micId: 'mic-12345',
    resumeKey: RESUME_KEY,
    slot: 4,
  });
  assert.deepEqual(read(JSON.stringify({ micId: 'mic-12345', slot: 9 })), { micId: 'mic-12345' });
  assert.equal(read('{nope'), null);
  assert.equal(read(JSON.stringify({ micId: 'short' })), null);
  assert.equal(read(JSON.stringify({ micId: 'mic-12345', resumeKey: 'ABC' })), null);
});

void test('a missing identity is created once and then reused', () => {
  const store = memoryStore();
  let made = 0;
  const make = () => {
    made += 1;
    return `fresh-mic-${made}`;
  };

  assert.deepEqual(ensureMicIdentity(store, make), { micId: 'fresh-mic-1' });
  assert.deepEqual(ensureMicIdentity(store, make), { micId: 'fresh-mic-1' });
  assert.equal(made, 1);
});

void test('the hello slot prefers this visit, then the QR, then the last visit', () => {
  const identity = { micId: 'mic-12345', slot: 4 as const };
  assert.equal(preferredSlot(1, 2, identity), 1);
  assert.equal(preferredSlot(null, 2, identity), 2);
  assert.equal(preferredSlot(null, null, identity), 4);
  assert.equal(preferredSlot(null, null, { micId: 'mic-12345' }), undefined);
});

void test('singer names are trimmed, cleaned and capped at 32 characters', () => {
  assert.equal(normalizeSingerName('  Jim \u0007 '), 'Jim');
  assert.equal(normalizeSingerName('   '), null);
  assert.equal(normalizeSingerName('🎤'.repeat(40)), '🎤'.repeat(32));

  const store = memoryStore();
  writeSingerName(store, 'Ana');
  assert.equal(readSingerName(store), 'Ana');
  writeSingerName(store, null);
  assert.equal(readSingerName(store), '');
});

void test('backoff follows 0.5, 1, 2, 4, 8 s with ±20 % jitter', () => {
  assert.deepEqual(
    BACKOFF_STEPS_MS.map((_, attempt) => backoffDelayMs(attempt, () => 0.5)),
    [500, 1_000, 2_000, 4_000, 8_000],
  );
  assert.equal(
    backoffDelayMs(10, () => 0.5),
    8_000,
  );
  assert.equal(
    backoffDelayMs(0, () => 0),
    400,
  );
  assert.equal(
    backoffDelayMs(0, () => 0.999_999),
    600,
  );
});

const half = (): number => 0.5;

void test('close codes map to the documented reconnect policy', () => {
  assert.deepEqual(decideOnClose(CLOSE_CODE.replaced, 0, false, half), {
    kind: 'stop',
    reason: 'replaced',
  });
  assert.deepEqual(decideOnClose(CLOSE_CODE.kicked, 0, false, half), {
    kind: 'stop',
    reason: 'kicked',
  });
  assert.deepEqual(decideOnClose(CLOSE_CODE.badRequest, 0, false, half), {
    kind: 'stop',
    reason: 'bad-request',
  });
  assert.deepEqual(decideOnClose(CLOSE_CODE.badResume, 0, false, half), {
    kind: 'retry-fresh-identity',
  });
  assert.deepEqual(decideOnClose(CLOSE_CODE.badResume, 2, true, half), {
    kind: 'retry',
    delayMs: 2_000,
  });
  assert.deepEqual(decideOnClose(CLOSE_CODE.slotsFull, 3, false, half), {
    kind: 'retry',
    delayMs: SLOTS_FULL_RETRY_MS,
  });
  for (const code of [
    1006,
    1000,
    CLOSE_CODE.timeout,
    CLOSE_CODE.rateLimited,
    CLOSE_CODE.tooLarge,
  ]) {
    assert.deepEqual(
      decideOnClose(code, 1, false, half),
      { kind: 'retry', delayMs: 1_000 },
      `${code}`,
    );
  }
});

void test('the meter maps -60..0 dBFS onto 0..1 and falls back slowly', () => {
  assert.equal(rms([0.5, -0.5, 0.5, -0.5]), 0.5);
  assert.equal(rms([]), 0);
  assert.equal(meterFraction(0), 0);
  assert.equal(meterFraction(1), 1);
  assert.equal(meterFraction(2), 1);
  assert.ok(Math.abs(meterFraction(10 ** (-30 / 20)) - 0.5) < 1e-9);
  assert.equal(meterFraction(10 ** (-70 / 20)), 0);

  assert.equal(nextMeterLevel(0.2, 0.9, 16), 0.9);
  assert.ok(Math.abs(nextMeterLevel(0.9, 0, 100) - 0.75) < 1e-9);
  assert.equal(nextMeterLevel(0.1, 0, 1_000), 0);
});
