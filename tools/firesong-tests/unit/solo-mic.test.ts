import { describe, expect, it, vi } from 'vitest';

import type { RemoteMicDevice } from '@/bridge/remote-mics';
import { soloMicId } from '@/features/remote-mic/solo-mic';

vi.mock('@/i18n', () => ({ t: (key: string) => key }));

const MIC_A = 'mic-aaaaaaaa';
const MIC_B = 'mic-bbbbbbbb';
const MIC_C = 'mic-cccccccc';

const device = (micId: string, slot: 1 | 2 | 3 | 4, reconnecting = false): RemoteMicDevice => ({
  id: `remote:${micId}`,
  micId,
  slot,
  label: `Slot ${slot}`,
  reconnecting,
});

describe('soloMicId', () => {
  it('replaces a saved phone that is not in the roster with the lowest connected one on the TV', () => {
    const devices = [device(MIC_C, 1, true), device(MIC_B, 2)];
    expect(soloMicId(`remote:${MIC_A}`, devices, true)).toBe(`remote:${MIC_B}`);
  });

  it('keeps a saved phone that is connected or reconnecting', () => {
    expect(soloMicId(`remote:${MIC_A}`, [device(MIC_B, 1), device(MIC_A, 2)], true)).toBe(
      `remote:${MIC_A}`,
    );
    expect(soloMicId(`remote:${MIC_A}`, [device(MIC_A, 1, true)], true)).toBe(`remote:${MIC_A}`);
  });

  it('names the lowest connected phone on the TV when nothing or a local mic is chosen', () => {
    expect(soloMicId(null, [device(MIC_B, 2)], true)).toBe(`remote:${MIC_B}`);
    expect(soloMicId('usb', [device(MIC_B, 2)], true)).toBe(`remote:${MIC_B}`);
  });

  it('gives no device on the TV when no phone is connected', () => {
    expect(soloMicId(`remote:${MIC_A}`, [], true)).toBeNull();
    expect(soloMicId(null, [device(MIC_B, 2, true)], true)).toBeNull();
  });

  it('leaves other browsers alone', () => {
    expect(soloMicId(`remote:${MIC_A}`, [], false)).toBe(`remote:${MIC_A}`);
    expect(soloMicId('usb', [device(MIC_B, 2)], false)).toBe('usb');
    expect(soloMicId(null, [device(MIC_B, 2)], false)).toBeNull();
  });
});
