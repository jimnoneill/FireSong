import { useSyncExternalStore } from 'react';

import { fireSongLaunch } from '@/bridge/firesong-launch';
import { remoteMics, type RemoteMicDevice } from '@/bridge/remote-mics';

import { parseRemoteMicDeviceId } from './protocol';

/**
 * The solo singer's device. On the TV (no local mics) it is always a phone in
 * the roster: the saved choice when that phone is still here, otherwise the
 * lowest connected slot, so a phone picked at an earlier party does not leave
 * the song unscored. An explicit id also lets per-phone latency and the song
 * result find the singer's slot. Players a queue request assigned keep their
 * own phone, so two players are never scored from one phone.
 */
export const soloMicId = (
  selected: string | null,
  devices: readonly RemoteMicDevice[],
  tvProfile: boolean,
): string | null => {
  const micId = parseRemoteMicDeviceId(selected);
  if (!tvProfile || (micId !== null && devices.some((device) => device.micId === micId))) {
    return selected;
  }
  return devices.find((device) => !device.reconnecting)?.id ?? null;
};

export function useSoloMicId(selected: string | null): string | null {
  const { devices } = useSyncExternalStore(remoteMics.subscribe, remoteMics.getSnapshot);
  return soloMicId(selected, devices, fireSongLaunch().tv);
}
