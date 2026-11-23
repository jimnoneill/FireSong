import {
  NATIVE_RATE,
  type AppMessage,
  type NativeMicLinkPort,
  type NativeSlotStatus,
  type PageMessage,
  type TapBlock,
} from '@/bridge/native-mic-protocol';
import type { MicSlot } from '@/features/remote-mic/protocol';

import type { MicRackPort, RackSlotStatus, TapListener } from './mic-rack';
import type { EchoMix, SlotMix } from './voice-params';

/** The app closes the whole door on a value outside these ranges, so nothing outside them is sent. */
const SLOT_VOLUME_MAX = 1.5;
const SLOT_ECHO_MAX = 2;
const ECHO_WET_MAX = 1;
const ECHO_FEEDBACK_MAX = 0.95;
const ECHO_LOWPASS_MIN_HZ = 500;
const ECHO_LOWPASS_MAX_HZ = 20_000;
const REVERB_SEND_MAX = 1;

/** `value` held to `[min, max]`; null when it is not a finite number. */
const bounded = (value: number, min: number, max: number): number | null =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null;

const rackStatus = (status: NativeSlotStatus): RackSlotStatus => ({
  attached: status.attached,
  monitored: status.monitored,
  levelRms: status.levelRms,
  gateOpen: status.gateOpen,
  muted: status.muted,
  gateThreshold: status.gateThreshold,
  feedbackHz: status.feedbackHz,
  boostDb: status.boostDb,
  echo: {
    delayMs: status.echo.delayMs,
    dryGain: status.echo.dryGain,
    wetGain: status.echo.wetGain,
    late: status.echo.late,
  },
  mix: { volume: status.mix.volume, echo: status.mix.echo },
});

/**
 * The rack of the app's voice engine: each setter becomes a mics-protocol
 * message, tap blocks reach the slot's listener, and `status` mirrors the
 * app's latest slot report. Attaching is the app's own (on its track event),
 * and the echo delay is fixed there, so `attach` and `setLatency` send nothing.
 */
export class NativeMicRack implements MicRackPort {
  private readonly taps = new Map<MicSlot, TapListener>();
  /** Slots the page has set up since their last release, as `MicRack` keeps strips. */
  private readonly known = new Set<MicSlot>();
  private statuses = new Map<MicSlot, RackSlotStatus>();

  constructor(private readonly link: NativeMicLinkPort) {
    link.subscribe((message) => this.onMessage(message));
    link.onTap((block) => this.onTap(block));
  }

  attach(): void {}

  detach(slot: MicSlot): void {
    this.link.send({ t: 'detach', slot });
  }

  release(slot: MicSlot): void {
    this.taps.delete(slot);
    this.known.delete(slot);
    this.statuses.delete(slot);
    this.link.send({ t: 'release', slot });
  }

  setTap(slot: MicSlot, listener: TapListener | null): void {
    if (listener === null) {
      this.taps.delete(slot);
      if (this.known.has(slot)) {
        this.link.send({ t: 'tap', slot, on: false });
      }
      return;
    }
    this.taps.set(slot, listener);
    this.control(slot, { t: 'tap', slot, on: true });
  }

  setMonitor(slot: MicSlot, on: boolean): void {
    if (on || this.known.has(slot)) {
      this.control(slot, { t: 'monitor', slot, on });
    }
  }

  setMuted(slot: MicSlot, muted: boolean): void {
    this.control(slot, { t: 'mute', slot, muted });
  }

  setLatency(): void {}

  setEchoMix(mix: EchoMix): void {
    const wet = bounded(mix.wet, 0, ECHO_WET_MAX);
    const feedback = bounded(mix.feedback, 0, ECHO_FEEDBACK_MAX);
    const lowpassHz = bounded(mix.lowpassHz, ECHO_LOWPASS_MIN_HZ, ECHO_LOWPASS_MAX_HZ);
    const reverbSend = bounded(mix.reverbSend, 0, REVERB_SEND_MAX);
    if (wet !== null && feedback !== null && lowpassHz !== null && reverbSend !== null) {
      this.link.send({ t: 'echo-mix', wet, feedback, lowpassHz, reverbSend });
    }
  }

  setSlotMix(slot: MicSlot, mix: SlotMix): void {
    const volume = bounded(mix.volume, 0, SLOT_VOLUME_MAX);
    const echo = bounded(mix.echo, 0, SLOT_ECHO_MAX);
    if (volume !== null && echo !== null) {
      this.control(slot, { t: 'mix', slot, volume, echo });
    }
  }

  status(slot: MicSlot): RackSlotStatus | null {
    return this.statuses.get(slot) ?? null;
  }

  private control(slot: MicSlot, message: PageMessage): void {
    this.known.add(slot);
    this.link.send(message);
  }

  /** Each `status` lists every slot the app knows, so a slot missing from it has no status. */
  private onMessage(message: AppMessage): void {
    if (message.t === 'status') {
      this.statuses = new Map(message.slots.map((status) => [status.slot, rackStatus(status)]));
    }
  }

  private onTap(block: TapBlock): void {
    this.taps.get(block.slot)?.(block.samples, NATIVE_RATE);
  }
}
