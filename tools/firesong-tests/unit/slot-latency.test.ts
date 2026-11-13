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

  it('follows the jitter-buffer drift since the calibration', () => {
    const latency = new SlotLatency();
    latency.observeJitter(30);
    expect(latency.setCalibrated(180)).toBe(true);
    expect(latency.effectiveMs()).toBe(180);
    latency.observeJitter(55);
    expect(latency.effectiveMs()).toBe(205);
    latency.observeJitter(20);
    expect(latency.effectiveMs()).toBe(170);
  });

  it('re-anchors on a new calibration and ignores repeats', () => {
    const latency = new SlotLatency();
    latency.setCalibrated(150);
    latency.observeJitter(40);
    expect(latency.effectiveMs()).toBe(150);
    latency.observeJitter(60);
    expect(latency.setCalibrated(150)).toBe(false);
    expect(latency.effectiveMs()).toBe(170);
    expect(latency.setCalibrated(200)).toBe(true);
    expect(latency.effectiveMs()).toBe(200);
  });

  it('clamps into 0-1000 ms', () => {
    const latency = new SlotLatency();
    latency.observeJitter(500);
    latency.setCalibrated(10);
    latency.observeJitter(0);
    expect(latency.effectiveMs()).toBe(0);
  });
});
