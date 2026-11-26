/**
 * Tuning values and pure helpers of the FireSong voice engine (design §3 and
 * §6e). Gains are linear, levels in dBFS, times in milliseconds unless the
 * name says otherwise.
 */

export const HPF_HZ = 100;

export const COMPRESSOR_THRESHOLD_DB = -24;
export const COMPRESSOR_RATIO = 4;
export const BUS_COMPRESSOR_THRESHOLD_DB = -18;
export const BUS_COMPRESSOR_RATIO = 3;
export const LIMITER_THRESHOLD_DB = -6;
export const LIMITER_RATIO = 20;

/**
 * Noraebang echo: repeats about 120 ms apart behind the full voice, fading
 * (feedback) and darkening (lowpass). It no longer follows the phone's latency:
 * on the Fire TV Cube the voice itself reaches the speakers 300 ms or more
 * after the singer, far past any echo spacing, and the old latency-locked echo
 * (and its quieter dry voice when late) made that delay worse.
 */
export const ECHO_DELAY_MS = 120;
/** Above this the TV copy of the voice is later than any echo can hide; the TV warns. */
export const ECHO_MAX_DELAY_MS = 220;
export const ECHO_FEEDBACK = 0.38;
export const ECHO_LOWPASS_HZ = 3000;
/** Low cut inside the echo loop: repeats thin out like a noraebang echo instead of piling up bass. */
export const ECHO_HIGHPASS_HZ = 300;
export const ECHO_WET_GAIN = 0.3;

export const REVERB_SEND = 0.14;
export const REVERB_SECONDS = 1.4;

/**
 * The gate only removes a phone's own hiss between phrases. It is fixed: a
 * threshold learned while a song plays learns the music, and phones send their
 * microphones without automatic gain, so it then cut normal singing.
 */
export const GATE_THRESHOLD_DB = -60;

/**
 * Phones send their microphones raw (no automatic gain), so a singer often
 * reaches the TV 20-30 dB under the song (a 2026-11-22 party: -60 to -42 dBFS
 * while singing). Each slot levels the loud parts of its singing toward
 * VOICE_TARGET_DB before the compressor, boosting by at most VOICE_MAX_BOOST_DB.
 * The level follows singing quickly up and slowly down, so a pause or the song
 * leaking into the phone does not pump the boost; quieter input never counts.
 */
export const VOICE_TARGET_DB = -24;
export const VOICE_MAX_BOOST_DB = 24;
/** The boost a slot starts with, before it has heard any singing. */
export const VOICE_START_BOOST_DB = 12;
export const VOICE_FLOOR_DB = -54;
export const VOICE_RISE_SEC = 0.3;
export const VOICE_FALL_SEC = 20;
/** Each confirmed howl lowers the slot's boost ceiling by this much. */
export const VOICE_HOWL_CUT_DB = 6;

export const FEEDBACK_PROMINENCE_DB = 15;
export const FEEDBACK_HOLD_MS = 300;
export const FEEDBACK_NOTCH_DB = -12;
export const FEEDBACK_NOTCH_Q = 30;
export const FEEDBACK_DUCK_DB = -6;
export const FEEDBACK_RELEASE_MS = 4000;

export const MAX_LATENCY_MS = 1000;

export const dbToGain = (db: number): number => 10 ** (db / 20);

export const gainToDb = (gain: number): number =>
  gain > 0 ? 20 * Math.log10(gain) : Number.NEGATIVE_INFINITY;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Echo and reverb levels chosen by the echo preset (noraebang settings,
 * `features/noraebang/echo.ts`). The delay never comes from the preset: it
 * stays locked to the slot's latency.
 */
export type EchoMix = {
  /** Echo send level for a slot within the latency budget. */
  wet: number;
  feedback: number;
  lowpassHz: number;
  reverbSend: number;
};

export const DEFAULT_ECHO_MIX: EchoMix = {
  wet: ECHO_WET_GAIN,
  feedback: ECHO_FEEDBACK,
  lowpassHz: ECHO_LOWPASS_HZ,
  reverbSend: REVERB_SEND,
};

const MAX_WET_GAIN = 0.6;

/**
 * A phone's own mixer (PROTOCOL.md §13.6 `mix`) as linear factors: `volume`
 * scales the slot's fader before the limiter, `echo` its echo send.
 */
export type SlotMix = { volume: number; echo: number };

export const DEFAULT_SLOT_MIX: SlotMix = { volume: 1, echo: 1 };

/** `volumePct` 0-150 and `echoPct` 0-200 as factors; 100 is unity. */
export const slotMixFromPct = (volumePct: number, echoPct: number): SlotMix => ({
  volume: clamp(volumePct, 0, 150) / 100,
  echo: clamp(echoPct, 0, 200) / 100,
});

/** The echo send of a slot with its own echo amount, still capped at the engine's maximum. */
export const mixedEchoWet = (wetGain: number, mix: SlotMix): number =>
  Math.min(MAX_WET_GAIN, wetGain * mix.echo);

export type EchoSettings = {
  /** `d_i`, the slot's echo delay. */
  delayMs: number;
  dryGain: number;
  wetGain: number;
  /** The measured latency is above the echo range; the TV should warn. */
  late: boolean;
};

/** The slot's echo: the full voice and a noraebang echo; `late` only flags a latency warning. */
export const echoSettingsFor = (
  latencyMs: number | null,
  mix: EchoMix = DEFAULT_ECHO_MIX,
): EchoSettings => ({
  delayMs: ECHO_DELAY_MS,
  dryGain: 1,
  wetGain: mix.wet,
  late: latencyMs !== null && Number.isFinite(latencyMs) && latencyMs > ECHO_MAX_DELAY_MS,
});

export const clampLatencyMs = (latencyMs: number): number => clamp(latencyMs, 0, MAX_LATENCY_MS);
