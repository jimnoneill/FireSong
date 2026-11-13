import { describe, expect, it, vi } from 'vitest';

import { phoneCalibration } from '@/features/remote-mic/calibration';
import type { LatencyMethod } from '@/features/remote-mic/protocol';

vi.mock('@/i18n', () => ({ t: (key: string) => key }));

const MIC_A = 'mic-aaaaaaaa';

const registry = (accepts: boolean) => {
  const reports: [string, number, LatencyMethod][] = [];
  return {
    reports,
    reportLatency: (micId: string, latencyMs: number, method: LatencyMethod) => {
      reports.push([micId, latencyMs, method]);
      return accepts;
    },
  };
};

describe('phoneCalibration', () => {
  it("saves a phone mic's beep test as that phone's own latency", () => {
    const fake = registry(true);
    expect(phoneCalibration(fake, `remote:${MIC_A}`, 0.1824)).toBe('saved');
    expect(fake.reports).toEqual([[MIC_A, 182, 'beep']]);
  });

  it('leaves local mics to the global compensation', () => {
    const fake = registry(true);
    expect(phoneCalibration(fake, 'usb', 0.12)).toBe('local');
    expect(phoneCalibration(fake, null, 0.12)).toBe('local');
    expect(fake.reports).toEqual([]);
  });

  it('reports a phone whose latency could not be sent', () => {
    expect(phoneCalibration(registry(false), `remote:${MIC_A}`, 0.2)).toBe('failed');
  });
});
