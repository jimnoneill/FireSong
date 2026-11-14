import { useSyncExternalStore } from 'react';

import { fireSongLaunch } from '@/bridge/firesong-launch';
import { remoteMics, type RemoteMicDevice } from '@/bridge/remote-mics';

import { parseRemoteMicDeviceId } from './protocol';

let partySolo: string | null = null;
const partySoloListeners = new Set<() => void>();

/**
 * The phone of the one singer of a queued song the party lobby starts. That
 * song is scored from this phone, even while it reconnects, never from
 * whichever phone is connected lowest; `null` once the lobby is back.
 */
export const setPartySoloMic = (deviceId: string | null): void => {
  if (deviceId === partySolo) {
    return;
  }
  partySolo = deviceId;
  for (const listener of partySoloListeners) {
    listener();
  }
};

export const partySoloMic = (): string | null => partySolo;

const subscribePartySolo = (listener: () => void): (() => void) => {
  partySoloListeners.add(listener);
  return () => {
    partySoloListeners.delete(listener);
  };
};

/**
 * The solo singer's device. On the TV (no local mics) it is always a phone:
 * the singer the party lobby named, otherwise the saved choice when that
 * phone is still here, otherwise the lowest connected slot, so a phone picked
 * at an earlier party does not leave the song unscored. An explicit id also
 * lets per-phone latency and the song result find the singer's slot. Players
 * a queue request assigned keep their own phone, so two players are never
 * scored from one phone.
 */
export const soloMicId = (
  selected: string | null,
  devices: readonly RemoteMicDevice[],
  tvProfile: boolean,
  partySinger: string | null = null,
): string | null => {
  if (tvProfile && parseRemoteMicDeviceId(partySinger) !== null) {
    return partySinger;
  }
  const micId = parseRemoteMicDeviceId(selected);
  if (!tvProfile || (micId !== null && devices.some((device) => device.micId === micId))) {
    return selected;
  }
  return devices.find((device) => !device.reconnecting)?.id ?? null;
};

export function useSoloMicId(selected: string | null): string | null {
  const { devices } = useSyncExternalStore(remoteMics.subscribe, remoteMics.getSnapshot);
  const partySinger = useSyncExternalStore(subscribePartySolo, partySoloMic);
  return soloMicId(selected, devices, fireSongLaunch().tv, partySinger);
}
