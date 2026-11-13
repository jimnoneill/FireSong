import { clampLatencyMs } from './voice-params';

/** Cumulative `inbound-rtp` jitter-buffer counters (seconds and samples). */
export type JitterCounters = { jitterBufferDelay: number; jitterBufferEmittedCount: number };

/**
 * Mean jitter-buffer delay in milliseconds over the window between two
 * `getStats` readings, or `null` when no audio was emitted in between.
 */
export const jitterBufferDelayMs = (
  previous: JitterCounters | null,
  next: JitterCounters,
): number | null => {
  const emitted = next.jitterBufferEmittedCount - (previous?.jitterBufferEmittedCount ?? 0);
  const delay = next.jitterBufferDelay - (previous?.jitterBufferDelay ?? 0);
  if (emitted <= 0 || delay < 0) {
    return null;
  }
  return (delay / emitted) * 1000;
};

/**
 * One slot's mouth-to-speaker latency `L_i`. The calibrated value (beep test,
 * persisted per mic on the server) is the anchor; between calibrations it
 * follows the change in jitter-buffer delay since the calibration was seen.
 */
export class SlotLatency {
  private calibratedMs: number | null = null;
  private referenceJitterMs: number | null = null;
  private jitterMs: number | null = null;

  /** Returns true when the calibrated value changed. */
  setCalibrated(latencyMs: number | null): boolean {
    if (latencyMs === this.calibratedMs) {
      return false;
    }
    this.calibratedMs = latencyMs;
    this.referenceJitterMs = this.jitterMs;
    return true;
  }

  observeJitter(jitterMs: number): void {
    this.jitterMs = jitterMs;
    this.referenceJitterMs ??= jitterMs;
  }

  /** `null` until the slot has been calibrated. */
  effectiveMs(): number | null {
    if (this.calibratedMs === null) {
      return null;
    }
    const drift =
      this.jitterMs !== null && this.referenceJitterMs !== null
        ? this.jitterMs - this.referenceJitterMs
        : 0;
    return clampLatencyMs(this.calibratedMs + drift);
  }

  currentJitterMs(): number | null {
    return this.jitterMs;
  }
}
