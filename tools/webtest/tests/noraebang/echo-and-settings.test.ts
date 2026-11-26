import { describe, expect, it } from 'vitest';

import { ECHO_PRESETS } from '@/features/noraebang/echo';
import {
  applyUrlOverrides,
  DEFAULT_NORAEBANG_SETTINGS,
  parseStoredSettings,
} from '@/features/noraebang/settings';

describe('noraebang echo presets', () => {
  it('keeps the noraebang preset and silences "off"', () => {
    expect(ECHO_PRESETS.noraebang).toMatchObject({
      wet: 0.3,
      feedback: 0.38,
      lowpassHz: 3000,
      reverbSend: 0.14,
    });
    expect(ECHO_PRESETS.off).toMatchObject({ wet: 0, feedback: 0, reverbSend: 0 });
  });

  it('orders the presets from dry to wet', () => {
    const { light, noraebang, hall } = ECHO_PRESETS;
    expect(light.wet).toBeLessThan(noraebang.wet);
    expect(noraebang.wet).toBeLessThan(hall.wet);
    expect(light.reverbSend).toBeLessThan(hall.reverbSend);
  });
});

describe('noraebang settings', () => {
  it('defaults to off with Korean captions, the noraebang echo and no voices on the TV', () => {
    expect(parseStoredSettings(null)).toEqual({
      enabled: false,
      koreanCaptions: true,
      echoPreset: 'noraebang',
      voicesOnTv: false,
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
    expect(applyUrlOverrides(DEFAULT_NORAEBANG_SETTINGS, '?voices=on')).toEqual({
      ...DEFAULT_NORAEBANG_SETTINGS,
      voicesOnTv: true,
    });
    expect(applyUrlOverrides(on, '?mode=karaoke&echo=loud')).toBeNull();
  });
});
