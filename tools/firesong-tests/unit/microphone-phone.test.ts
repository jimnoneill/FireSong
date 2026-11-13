import { describe, expect, it, vi } from 'vitest';

import type { MicrophoneAdapter } from '@/bridge/microphone';
import { withRemoteMics, type RemoteMicRegistry } from '@/bridge/microphone.phone';
import type { RemoteMicDevice } from '@/bridge/remote-mics';

vi.mock('@/i18n', () => ({ t: (key: string) => key }));

const MIC_A = 'mic-aaaaaaaa';
const MIC_B = 'mic-bbbbbbbb';

const device = (micId: string, slot: 1 | 2 | 3 | 4, reconnecting = false): RemoteMicDevice => ({
  id: `remote:${micId}`,
  micId,
  slot,
  label: `Slot ${slot}`,
  reconnecting,
});

const platform = (listing: () => Promise<Awaited<ReturnType<MicrophoneAdapter['listDevices']>>>) => {
  const calls: string[] = [];
  const adapter: MicrophoneAdapter = {
    listDevices: listing,
    startCapture: async (captureId, preferred) => {
      calls.push(`start:${captureId}:${preferred ?? 'default'}`);
      return 'Built-in';
    },
    stopCapture: async (captureId) => {
      calls.push(`stop:${captureId}`);
    },
    setMonitoring: async (captureId, on) => {
      calls.push(`monitor:${captureId}:${on}`);
    },
    subscribe: async () => () => undefined,
  };
  return { adapter, calls };
};

const registry = (devices: RemoteMicDevice[]) => {
  const bindings = new Map<string, { micId: string; monitor: boolean }>();
  const fake: RemoteMicRegistry = {
    devices: () => devices,
    bind: (captureId, micId, monitor) => {
      bindings.set(captureId, { micId, monitor });
    },
    unbind: (captureId) => bindings.delete(captureId),
    setMonitoring: (captureId, monitor) => {
      const binding = bindings.get(captureId);
      if (binding === undefined) {
        return false;
      }
      binding.monitor = monitor;
      return true;
    },
  };
  return { fake, bindings };
};

const LOCAL = { id: 'usb', name: 'USB mic', host: 'Browser', channel_count: 1 };

describe('withRemoteMics listDevices', () => {
  it('lists phone mics first, then local devices', async () => {
    const { adapter } = platform(async () => [LOCAL]);
    const { fake } = registry([device(MIC_A, 2)]);
    const wrapped = withRemoteMics(adapter, fake, { tvProfile: () => false });
    expect(await wrapped.listDevices(true)).toEqual([
      { id: `remote:${MIC_A}`, name: 'Slot 2', host: 'FireSong', channel_count: 1 },
      LOCAL,
    ]);
  });

  it('never enumerates local devices on the TV', async () => {
    const listing = vi.fn(async () => [LOCAL]);
    const { adapter } = platform(listing);
    const wrapped = withRemoteMics(adapter, registry([]).fake, { tvProfile: () => true });
    expect(await wrapped.listDevices(true)).toEqual([]);
    expect(listing).not.toHaveBeenCalled();
  });

  it('swallows a local enumeration error only when phone mics exist', async () => {
    const failing = async () => {
      throw new Error('denied');
    };
    const withPhone = withRemoteMics(platform(failing).adapter, registry([device(MIC_A, 1)]).fake, {
      tvProfile: () => false,
    });
    expect(await withPhone.listDevices(true)).toHaveLength(1);
    const withoutPhone = withRemoteMics(platform(failing).adapter, registry([]).fake, {
      tvProfile: () => false,
    });
    await expect(withoutPhone.listDevices(true)).rejects.toThrow('denied');
  });
});

describe('withRemoteMics capture', () => {
  it('binds a phone id without touching tracks and never falls back to a local mic', async () => {
    const { adapter, calls } = platform(async () => []);
    const { fake, bindings } = registry([]);
    const wrapped = withRemoteMics(adapter, fake, { tvProfile: () => false });
    const label = await wrapped.startCapture('p1', `remote:${MIC_B}`, { emit_audio: true });
    expect(label).toBe(`remote:${MIC_B}`);
    expect(bindings.get('p1')).toEqual({ micId: MIC_B, monitor: true });
    expect(calls).toEqual(['stop:p1']);

    await wrapped.setMonitoring('p1', false);
    expect(bindings.get('p1')?.monitor).toBe(false);
    await wrapped.stopCapture('p1');
    expect(bindings.has('p1')).toBe(false);
    expect(calls).toEqual(['stop:p1']);
  });

  it('delegates local ids and drops any phone binding for that capture id', async () => {
    const { adapter, calls } = platform(async () => []);
    const { fake, bindings } = registry([device(MIC_A, 1)]);
    const wrapped = withRemoteMics(adapter, fake, { tvProfile: () => false });
    await wrapped.startCapture('p1', `remote:${MIC_A}`, { emit_audio: false });
    expect(await wrapped.startCapture('p1', 'usb', { emit_audio: false })).toBe('Built-in');
    expect(bindings.has('p1')).toBe(false);
    await wrapped.setMonitoring('p1', true);
    await wrapped.stopCapture('p1');
    expect(calls).toEqual(['stop:p1', 'start:p1:usb', 'monitor:p1:true', 'stop:p1']);
  });

  it('gives the TV the lowest connected phone when no phone id is chosen', async () => {
    const { adapter, calls } = platform(async () => []);
    const { fake, bindings } = registry([device(MIC_A, 1, true), device(MIC_B, 3)]);
    const wrapped = withRemoteMics(adapter, fake, { tvProfile: () => true });
    expect(await wrapped.startCapture('solo', null, { emit_audio: false })).toBe('Slot 3');
    expect(bindings.get('solo')?.micId).toBe(MIC_B);
    expect(calls).toEqual([]);
  });

  it('fails clearly on the TV when no phone is connected', async () => {
    const { adapter, calls } = platform(async () => []);
    const wrapped = withRemoteMics(adapter, registry([]).fake, { tvProfile: () => true });
    await expect(wrapped.startCapture('solo', null, { emit_audio: false })).rejects.toThrow(
      'firesong.remoteMic.noPhoneMic',
    );
    expect(calls).toEqual([]);
  });
});
