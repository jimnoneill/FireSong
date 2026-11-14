import {
  MAX_LATENCY_MS,
  remoteMicDeviceId,
  type CalibrationFailure,
  type LatencyMethod,
  type MicSlot,
  type TvPartyToServer,
} from './protocol';

/**
 * "Tune my mic" from a phone (PROTOCOL.md §13.6 `calibrate`): the settings
 * beep test, run for that phone's slot on the always-running voice engine,
 * because nobody stands at the TV to unlock a new AudioContext. Progress goes
 * back as `calibration`; a result is also stored with the v1 `latency`.
 */

export type PhoneCalibratorDeps = {
  /** The beep test of a device, in seconds; rejects when no beep is heard. */
  measure(deviceId: string): Promise<number>;
  send(frame: TvPartyToServer): boolean;
  reportLatency(micId: string, latencyMs: number, method: LatencyMethod): boolean;
  /** The slot's phone audio is attached to the rack. */
  hasAudio(slot: MicSlot): boolean;
  /** The TV is in the lobby, with no song starting or playing. */
  idle(): boolean;
  /** Shows or hides "Tuning <name>'s mic…". */
  setTuning(slot: MicSlot | null): void;
  /** Gives the room a moment to go quiet once the notice is up. */
  settle(): Promise<void>;
};

export const CALIBRATION_SETTLE_MS = 800;

export class PhoneCalibrator {
  private running = false;

  constructor(private readonly deps: PhoneCalibratorDeps) {}

  /** Runs one calibration; failures are reported to the phone, never thrown. */
  run(slot: MicSlot, micId: string): void {
    if (this.running || !this.deps.idle()) {
      this.fail(slot, 'busy');
      return;
    }
    if (!this.deps.hasAudio(slot)) {
      this.fail(slot, 'no-audio');
      return;
    }
    this.running = true;
    this.deps.send({ type: 'calibration', slot, state: 'started' });
    this.deps.setTuning(slot);
    void this.measure(slot, micId)
      .catch(() => this.fail(slot, 'no-tone'))
      .finally(() => {
        this.running = false;
        this.deps.setTuning(null);
      });
  }

  isRunning(): boolean {
    return this.running;
  }

  private async measure(slot: MicSlot, micId: string): Promise<void> {
    await this.deps.settle();
    const seconds = await this.deps.measure(remoteMicDeviceId(micId));
    const latencyMs = Math.min(MAX_LATENCY_MS, Math.max(0, Math.round(seconds * 1000)));
    this.deps.reportLatency(micId, latencyMs, 'beep');
    this.deps.send({ type: 'calibration', slot, state: 'done', latencyMs });
  }

  private fail(slot: MicSlot, reason: CalibrationFailure): void {
    this.deps.send({ type: 'calibration', slot, state: 'failed', reason });
  }
}
