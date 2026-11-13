import { parseRemoteMicDeviceId, REMOTE_MIC_HOST } from '@/features/remote-mic/protocol';
import { t } from '@/i18n';
import type { MicrophoneInfo } from '@/types/MicrophoneInfo';

import type { MicrophoneAdapter } from './microphone';
import type { RemoteMicDevice } from './remote-mics';

/** The part of the phone-mic registry the adapter needs. */
export type RemoteMicRegistry = {
  devices(): readonly RemoteMicDevice[];
  bind(captureId: string, micId: string, monitor: boolean): void;
  unbind(captureId: string): boolean;
  setMonitoring(captureId: string, monitor: boolean): boolean;
};

export type RemoteMicAdapterOptions = {
  /** The TV has no local microphone; enumerating one would raise a permission prompt. */
  tvProfile: () => boolean;
};

const toInfo = (device: RemoteMicDevice): MicrophoneInfo => ({
  id: device.id,
  name: device.label,
  host: REMOTE_MIC_HOST,
  channel_count: 1,
});

/**
 * Wraps the platform adapter so phone mics (`remote:<micId>`) look like local
 * devices to multiplayer, pitch and scoring (PROTOCOL.md §8). A phone id
 * never falls back to a local mic; on the TV, a capture without a phone id
 * takes the lowest connected slot.
 */
export const withRemoteMics = (
  platform: MicrophoneAdapter,
  registry: RemoteMicRegistry,
  { tvProfile }: RemoteMicAdapterOptions,
): MicrophoneAdapter => {
  const resolveMicId = (preferred: string | null): string | null => {
    const micId = parseRemoteMicDeviceId(preferred);
    if (micId !== null || !tvProfile()) {
      return micId;
    }
    const first = registry.devices().find((device) => !device.reconnecting);
    if (first === undefined) {
      throw new Error(t('firesong.remoteMic.noPhoneMic'));
    }
    return first.micId;
  };

  return {
    async listDevices(combineChannels) {
      const remote = registry.devices().map(toInfo);
      if (tvProfile()) {
        return remote;
      }
      try {
        return [...remote, ...(await platform.listDevices(combineChannels))];
      } catch (error) {
        if (remote.length > 0) {
          return remote;
        }
        throw error;
      }
    },

    async startCapture(captureId, preferred, options) {
      const micId = resolveMicId(preferred);
      if (micId === null) {
        registry.unbind(captureId);
        return platform.startCapture(captureId, preferred, options);
      }
      if (!tvProfile()) {
        await platform.stopCapture(captureId);
      }
      registry.bind(captureId, micId, options.emit_audio);
      const device = registry.devices().find((candidate) => candidate.micId === micId);
      return device?.label ?? preferred ?? micId;
    },

    async stopCapture(captureId) {
      if (!registry.unbind(captureId)) {
        await platform.stopCapture(captureId);
      }
    },

    async setMonitoring(captureId, enabled) {
      if (!registry.setMonitoring(captureId, enabled)) {
        await platform.setMonitoring(captureId, enabled);
      }
    },

    subscribe: (captureId, callback) => platform.subscribe(captureId, callback),
  };
};
