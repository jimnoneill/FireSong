import { describe, expect, it } from 'vitest';

import {
  clampLatencyMs,
  dbToGain,
  ECHO_DELAY_MS,
  ECHO_WET_GAIN,
  echoSettingsFor,
  gainToDb,
  mixedEchoWet,
  slotMixFromPct,
} from '@/audio/voice-params';

describe('echoSettingsFor (a fixed noraebang echo behind the full voice)', () => {
  it.each([null, Number.NaN, 0, 60, 150, 220])('latency %s ms keeps the 120 ms echo', (latency) => {
    const echo = echoSettingsFor(latency);
    expect(echo.delayMs).toBe(ECHO_DELAY_MS);
    expect(echo.late).toBe(false);
    expect(echo.dryGain).toBe(1);
    expect(echo.wetGain).toBe(ECHO_WET_GAIN);
  });

  it('only flags a warning above 220 ms; the voice stays at full level', () => {
    expect(echoSettingsFor(300)).toMatchObject({
      delayMs: ECHO_DELAY_MS,
      late: true,
      dryGain: 1,
      wetGain: ECHO_WET_GAIN,
    });
  });

  it('takes the wet level from the echo preset', () => {
    const hall = { wet: 0.42, feedback: 0.55, lowpassHz: 2800, reverbSend: 0.3 };
    expect(echoSettingsFor(150, hall)).toMatchObject({ delayMs: ECHO_DELAY_MS, wetGain: 0.42 });
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
    expect(mixedEchoWet(0.5, slotMixFromPct(100, 0))).toBe(0);
  });
});
