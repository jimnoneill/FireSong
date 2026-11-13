/** Bottom of the meter scale in dBFS; anything quieter reads as 0. */
export const METER_FLOOR_DB = -60;
/** How fast the bar falls back after a peak, in meter units per second. */
export const METER_RELEASE_PER_SEC = 1.5;

/** Root mean square of one block of samples in [-1, 1]. */
export const rms = (samples: ArrayLike<number>): number => {
  if (samples.length === 0) {
    return 0;
  }

  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
};

/** Level in dBFS mapped onto 0..1 between {@link METER_FLOOR_DB} and 0 dBFS. */
export const meterFraction = (rmsValue: number): number => {
  if (!(rmsValue > 0)) {
    return 0;
  }

  const db = 20 * Math.log10(rmsValue);
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
};

/** Peak-follower ballistics: rises at once, falls at {@link METER_RELEASE_PER_SEC}. */
export const nextMeterLevel = (previous: number, target: number, elapsedMs: number): number => {
  const released = previous - (METER_RELEASE_PER_SEC * Math.max(0, elapsedMs)) / 1_000;
  return Math.min(1, Math.max(target, released, 0));
};
