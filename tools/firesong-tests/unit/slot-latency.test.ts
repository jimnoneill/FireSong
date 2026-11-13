import { describe, expect, it } from 'vitest';

import { jitterBufferDelayMs, SlotLatency } from '@/audio/slot-latency';

describe('jitterBufferDelayMs', () => {
  it('averages the delay over the samples emitted in the window', () => {
    // jitterBufferDelay sums, over emitted samples, each one's seconds in the buffer.
    const first = { jitterBufferDelay: 48_000, jitterBufferEmittedCount: 960_000 };
    const second = { jitterBufferDelay: 48_000 + 4_800, jitterBufferEmittedCount: 1_056_000 };
    expect(jitterBufferDelayMs(first, second)).toBeCloseTo(50, 9);
  });

  it('uses the cumulative value for the first reading', () => {
    expect(
      jitterBufferDelayMs(null, { jitterBufferDelay: 2_400, jitterBufferEmittedCount: 96_000 }),
    ).toBeCloseTo(25, 9);
  });

  it('returns null when nothing was emitted or the counters reset', () => {
    const reading = { jitterBufferDelay: 10, jitterBufferEmittedCount: 1000 };
    expect(jitterBufferDelayMs(reading, reading)).toBeNull();
    expect(
      jitterBufferDelayMs(reading, { jitterBufferDelay: 1, jitterBufferEmittedCount: 2000 }),
    ).toBeNull();
  });
});

describe('SlotLatency', () => {
  it('is null until calibrated', () => {
    const latency = new SlotLatency();
    latency.observeJitter(40);
    expect(latency.effectiveMs()).toBeNull();
    expect(latency.currentJitterMs()).toBe(40);
  });

  it('adds the jitter-buffer excess over the connection baseline', () => {
    const latency = new SlotLatency();
    expect(latency.setCalibrated(180)).toBe(true);
    expect(latency.effectiveMs()).toBe(180);
    latency.observeJitter(30);
    expect(latency.effectiveMs()).toBe(180);
    latency.observeJitter(55);
    expect(latency.effectiveMs()).toBe(205);
    latency.observeJitter(20);
    expect(latency.effectiveMs()).toBe(180);
    latency.observeJitter(32);
    expect(latency.effectiveMs()).toBe(192);
  });

  it('settles back to the calibration after start-up buffering', () => {
    const latency = new SlotLatency();
    latency.setCalibrated(150);
    for (const jitter of [362, 134, 61, 39, 39]) {
      latency.observeJitter(jitter);
    }
    expect(latency.effectiveMs()).toBe(150);
  });

  it('a persisted calibration survives a reconnect with a new baseline', () => {
    const latency = new SlotLatency();
    latency.setCalibrated(150);
    latency.observeJitter(20);
    latency.resetJitter();
    expect(latency.currentJitterMs()).toBeNull();
    latency.observeJitter(300);
    expect(latency.effectiveMs()).toBe(150);
    latency.observeJitter(40);
    latency.observeJitter(90);
    expect(latency.effectiveMs()).toBe(200);
    expect(latency.setCalibrated(150)).toBe(false);
  });

  it('clamps into 0-1000 ms', () => {
    const latency = new SlotLatency();
    latency.setCalibrated(900);
    latency.observeJitter(0);
    latency.observeJitter(400);
    expect(latency.effectiveMs()).toBe(1000);
  });
});
