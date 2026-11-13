import { fireSongLaunch } from '@/bridge/firesong-launch';
import { remoteMics, type RemoteMics } from '@/bridge/remote-mics';

import { parseRemoteMicDeviceId } from './protocol';
import { soloMicId } from './solo-mic';

export type PhoneCalibration = 'local' | 'saved' | 'failed';

/** The device a latency test of `selected` measures: on the TV, the solo singer's phone. */
export const latencyTestDeviceId = (selected: string | null): string | null =>
  soloMicId(selected, remoteMics.devices(), fireSongLaunch().tv);

/**
 * A beep test of a phone mic measures that phone's own loop, so it becomes
 * the phone's calibrated latency (PROTOCOL.md §5.2 `latency`): its scoring
 * offset, echo delay and jitter tracking then follow that phone. Local mics
 * keep the global compensation (`local`).
 */
export const phoneCalibration = (
  registry: Pick<RemoteMics, 'reportLatency'>,
  deviceId: string | null,
  latencySec: number,
): PhoneCalibration => {
  const micId = parseRemoteMicDeviceId(deviceId);
  if (micId === null) {
    return 'local';
  }
  return registry.reportLatency(micId, Math.round(latencySec * 1000), 'beep') ? 'saved' : 'failed';
};

export const savePhoneMicLatency = (
  deviceId: string | null,
  latencySec: number,
): PhoneCalibration => phoneCalibration(remoteMics, deviceId, latencySec);
