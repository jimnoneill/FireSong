import { describe, expect, it } from 'vitest';

import {
  ECHO_FIXED_DELAY_MS,
  ECHO_MAX_DELAY_MS,
  ECHO_MIN_DELAY_MS,
  ECHO_PRESETS,
  slotEcho,
} from '@/features/noraebang/echo';
import {
  applyUrlOverrides,
  DEFAULT_NORAEBANG_SETTINGS,
  parseStoredSettings,
} from '@/features/noraebang/settings';

describe('latency-locked echo', () => {
  const preset = ECHO_PRESETS.noraebang;

  it('locks the delay to the slot latency between 90 and 220 ms', () => {
    expect(slotEcho(preset, 150).delayMs).toBe(150);
    expect(slotEcho(preset, 75).delayMs).toBe(ECHO_MIN_DELAY_MS);
    expect(slotEcho(preset, 220)).toMatchObject({ delayMs: 220, latencyWarning: false });
  });

  it('uses the fixed 160 ms echo when latency is low or unknown', () => {
    for (const latency of [null, 0, 59, Number.NaN, -5]) {
      expect(slotEcho(preset, latency).delayMs).toBe(ECHO_FIXED_DELAY_MS);
    }
  });

  it('warns and raises the wet level over budget', () => {
    const echo = slotEcho(preset, 300);
    expect(echo.delayMs).toBe(ECHO_MAX_DELAY_MS);
    expect(echo.latencyWarning).toBe(true);
    expect(echo.wet).toBeGreaterThan(preset.wet);
    expect(echo.wet).toBeLessThanOrEqual(0.6);
  });

  it('keeps the design values for the default preset and silences "off"', () => {
    expect(ECHO_PRESETS.noraebang).toMatchObject({
      feedback: 0.38,
      lowpassHz: 3500,
      reverbSend: 0.2,
    });
    expect(slotEcho(ECHO_PRESETS.off, 150)).toMatchObject({ wet: 0, feedback: 0, reverbSend: 0 });
  });
});

describe('noraebang settings', () => {
  it('defaults to off with Korean captions and the noraebang echo', () => {
    expect(parseStoredSettings(null)).toEqual({
      enabled: false,
      koreanCaptions: true,
      echoPreset: 'noraebang',
    });
  });

  it('keeps valid stored fields and drops bad ones individually', () => {
    expect(parseStoredSettings('{"enabled":true,"echoPreset":"stadium"}')).toEqual({
      ...DEFAULT_NORAEBANG_SETTINGS,
      enabled: true,
    });
    expect(parseStoredSettings('not json')).toEqual(DEFAULT_NORAEBANG_SETTINGS);
    expect(parseStoredSettings('[1,2]')).toEqual(DEFAULT_NORAEBANG_SETTINGS);
  });

  it('switches mode from the URL and ignores unrelated queries', () => {
    expect(applyUrlOverrides(DEFAULT_NORAEBANG_SETTINGS, '?tv=1&mode=noraebang')).toEqual({
      ...DEFAULT_NORAEBANG_SETTINGS,
      enabled: true,
    });
    const on = { ...DEFAULT_NORAEBANG_SETTINGS, enabled: true };
    expect(applyUrlOverrides(on, '?mode=classic&echo=hall')).toEqual({
      ...DEFAULT_NORAEBANG_SETTINGS,
      echoPreset: 'hall',
    });
    expect(applyUrlOverrides(on, '?tv=1')).toBeNull();
    expect(applyUrlOverrides(on, '?mode=karaoke&echo=loud')).toBeNull();
  });
});
