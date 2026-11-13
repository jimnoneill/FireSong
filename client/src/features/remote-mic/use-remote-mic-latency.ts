import { useCallback, useSyncExternalStore } from 'react';

import { remoteMics } from '@/bridge/remote-mics';

import { parseRemoteMicDeviceId } from './protocol';

/**
 * Per-slot scoring latency: for a `remote:<micId>` device, the mic's
 * effective mouth-to-speaker latency in seconds; `null` for local devices and
 * uncalibrated phone mics, which keep the global compensation.
 */
export function useRemoteMicLatencySec(): (deviceId: string | null) => number | null {
  const snapshot = useSyncExternalStore(remoteMics.subscribe, remoteMics.getSnapshot);

  return useCallback(
    (deviceId: string | null) => {
      const micId = parseRemoteMicDeviceId(deviceId);
      const latencyMs = micId === null ? undefined : snapshot.latencyMs.get(micId);
      return latencyMs === undefined ? null : latencyMs / 1000;
    },
    [snapshot],
  );
}
