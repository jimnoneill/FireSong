import { describe, expect, it } from 'vitest';

import {
  clampLatencyMs,
  dbToGain,
  ECHO_FIXED_DELAY_MS,
  ECHO_LATE_WET_GAIN,
  ECHO_WET_GAIN,
  echoSettingsFor,
  gainToDb,
  mixedEchoWet,
  slotMixFromPct,
} from '@/audio/voice-params';

describe('echoSettingsFor (d_i = clamp(L_i, 90, 220), fixed 160 below 60)', () => {
  it.each([
    [null, 160],
    [Number.NaN, 160],
    [0, 160],
    [59.9, 160],
    [60, 90],
    [89, 90],
    [90, 90],
    [150, 150],
    [220, 220],
  ])('latency %s ms gives a %s ms echo', (latency, delay) => {
    const echo = echoSettingsFor(latency);
    expect(echo.delayMs).toBe(delay);
    expect(echo.late).toBe(false);
    expect(echo.dryGain).toBe(1);
    expect(echo.wetGain).toBe(ECHO_WET_GAIN);
  });

  it('keeps the fixed echo for unknown latency', () => {
    expect(echoSettingsFor(null).delayMs).toBe(ECHO_FIXED_DELAY_MS);
  });

  it('raises the wet/dry ratio and flags a warning above 220 ms', () => {
    const echo = echoSettingsFor(300);
    expect(echo).toMatchObject({ delayMs: 220, late: true, wetGain: ECHO_LATE_WET_GAIN });
    expect(echo.wetGain / echo.dryGain).toBeGreaterThan(ECHO_WET_GAIN);
  });

  it('takes the wet level from the echo preset but keeps the delay latency-locked', () => {
    const hall = { wet: 0.42, feedback: 0.5, lowpassHz: 3000, reverbSend: 0.32 };
    expect(echoSettingsFor(150, hall)).toMatchObject({ delayMs: 150, wetGain: 0.42, late: false });
    expect(echoSettingsFor(null, hall)).toMatchObject({ delayMs: 160, wetGain: 0.42 });
    const late = echoSettingsFor(300, hall);
    expect(late).toMatchObject({ delayMs: 220, late: true });
    expect(late.wetGain).toBeGreaterThan(0.42);
    expect(late.wetGain).toBeLessThanOrEqual(0.6);
    expect(echoSettingsFor(150, { ...hall, wet: 0 }).wetGain).toBe(0);
  });
});

describe('level helpers', () => {
  it('round-trips dB and gain', () => {
    for (const db of [-60, -12, -6, 0, 6]) {
      expect(gainToDb(dbToGain(db))).toBeCloseTo(db, 9);
    }
    expect(gainToDb(0)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('clamps latency into 0-1000 ms', () => {
    expect(clampLatencyMs(-5)).toBe(0);
    expect(clampLatencyMs(400)).toBe(400);
    expect(clampLatencyMs(5000)).toBe(1000);
  });
});

describe("a phone's own mix (PROTOCOL.md §13.6 mix)", () => {
  it('turns percentages into a fader factor and an echo factor, 100 % = unity', () => {
    expect(slotMixFromPct(100, 100)).toEqual({ volume: 1, echo: 1 });
    expect(slotMixFromPct(150, 0)).toEqual({ volume: 1.5, echo: 0 });
    expect(slotMixFromPct(400, 300)).toEqual({ volume: 1.5, echo: 2 });
  });

  it('scales the echo send and keeps it under the 0.6 cap', () => {
    expect(mixedEchoWet(ECHO_WET_GAIN, slotMixFromPct(100, 100))).toBeCloseTo(ECHO_WET_GAIN);
    expect(mixedEchoWet(ECHO_WET_GAIN, slotMixFromPct(100, 50))).toBeCloseTo(ECHO_WET_GAIN / 2);
    expect(mixedEchoWet(ECHO_WET_GAIN, slotMixFromPct(100, 200))).toBeCloseTo(0.6);
    expect(mixedEchoWet(ECHO_LATE_WET_GAIN, slotMixFromPct(100, 0))).toBe(0);
  });
});
