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
 * persisted per mic on the server) is taken as the steady-state latency, when
 * the jitter buffer sits at its lowest level for the connection. Whenever the
 * buffer holds more than that (start-up, Wi-Fi trouble), the excess adds to
 * the latency, so it follows the jitter buffer between calibrations. A
 * calibration measured on the other voice backend (the page or the TV app)
 * also gets that backend's difference in delivery delay.
 */
export class SlotLatency {
  private calibratedMs: number | null = null;
  private baselineJitterMs: number | null = null;
  private jitterMs: number | null = null;
  private backendCorrectionMs = 0;

  /** Returns true when the calibrated value changed. */
  setCalibrated(latencyMs: number | null): boolean {
    if (latencyMs === this.calibratedMs) {
      return false;
    }
    this.calibratedMs = latencyMs;
    return true;
  }

  /** Added to the calibrated value; returns true when it changed. */
  setBackendCorrectionMs(correctionMs: number): boolean {
    if (correctionMs === this.backendCorrectionMs) {
      return false;
    }
    this.backendCorrectionMs = correctionMs;
    return true;
  }

  /** A new connection has its own jitter buffer, so its own baseline. */
  resetJitter(): void {
    this.baselineJitterMs = null;
    this.jitterMs = null;
  }

  observeJitter(jitterMs: number): void {
    this.jitterMs = jitterMs;
    this.baselineJitterMs = Math.min(this.baselineJitterMs ?? jitterMs, jitterMs);
  }

  /** `null` until the slot has been calibrated. */
  effectiveMs(): number | null {
    if (this.calibratedMs === null) {
      return null;
    }
    const excess =
      this.jitterMs !== null && this.baselineJitterMs !== null
        ? this.jitterMs - this.baselineJitterMs
        : 0;
    return clampLatencyMs(this.calibratedMs + this.backendCorrectionMs + excess);
  }

  currentJitterMs(): number | null {
    return this.jitterMs;
  }
}
