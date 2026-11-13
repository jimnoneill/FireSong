import { CLOSE_CODE, NO_RECONNECT_CLOSE_CODES } from '@/features/remote-mic/protocol';

/** Backoff steps of the client reconnect policy (PROTOCOL.md §4.1), in ms. */
export const BACKOFF_STEPS_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000];
export const BACKOFF_JITTER = 0.2;
/** A socket that stayed up this long starts the next backoff from the first step. */
export const BACKOFF_RESET_AFTER_MS = 30_000;
export const SLOTS_FULL_RETRY_MS = 5_000;

export type StopReason = 'replaced' | 'kicked' | 'bad-request';

export type CloseDecision =
  | { kind: 'retry'; delayMs: number }
  | { kind: 'retry-fresh-identity' }
  | { kind: 'stop'; reason: StopReason };

/** `random` is in [0, 1); the result is within ±20 % of the step. */
export const backoffDelayMs = (attempt: number, random: () => number): number => {
  const step = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)] ?? 8_000;
  const jitter = (random() * 2 - 1) * BACKOFF_JITTER;
  return Math.round(step * (1 + jitter));
};

const stopReasonFor = (code: number): StopReason | null => {
  if (code === CLOSE_CODE.kicked) {
    return 'kicked';
  }
  if (NO_RECONNECT_CLOSE_CODES.includes(code)) {
    return 'replaced';
  }
  return code === CLOSE_CODE.badRequest ? 'bad-request' : null;
};

/**
 * What the phone does after its `/rtc` socket closes. `attempt` counts the
 * reconnects since the socket was last up for {@link BACKOFF_RESET_AFTER_MS};
 * `freshIdentityTried` is set once a `bad-resume` reset has been spent.
 */
export const decideOnClose = (
  code: number,
  attempt: number,
  freshIdentityTried: boolean,
  random: () => number,
): CloseDecision => {
  const stop = stopReasonFor(code);
  if (stop !== null) {
    return { kind: 'stop', reason: stop };
  }
  if (code === CLOSE_CODE.badResume && !freshIdentityTried) {
    return { kind: 'retry-fresh-identity' };
  }
  if (code === CLOSE_CODE.slotsFull) {
    return { kind: 'retry', delayMs: SLOTS_FULL_RETRY_MS };
  }
  return { kind: 'retry', delayMs: backoffDelayMs(attempt, random) };
};
