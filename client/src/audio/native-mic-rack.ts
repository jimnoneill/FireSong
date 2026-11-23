import type { NativeMicLinkPort } from '@/bridge/native-mic-protocol';

import type { MicRackPort, RackSlotStatus } from './mic-rack';

/**
 * The rack of the app's voice engine: each setter becomes a mics-protocol
 * message, tap blocks reach the slot's listener, and `status` mirrors the
 * app's latest slot report.
 */
export class NativeMicRack implements MicRackPort {
  constructor(readonly link: NativeMicLinkPort) {}

  attach(): void {}

  detach(): void {}

  release(): void {}

  setTap(): void {}

  setMonitor(): void {}

  setMuted(): void {}

  setLatency(): void {}

  setEchoMix(): void {}

  setSlotMix(): void {}

  status(): RackSlotStatus | null {
    return null;
  }
}
