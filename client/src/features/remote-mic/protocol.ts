/**
 * FireSong phone-microphone contract, client side.
 *
 * The wire types are generated from `app-core/src/remote_mic.rs` by ts-rs
 * into `@/types/firesong/`; this module re-exports them together with the
 * constants, device-id helpers and runtime validators that the TV
 * (`remote-mics` singleton) and the phone page (`/m`) share. The prose
 * contract is `docs/firesong/PROTOCOL.md`. Constants mirror the Rust ones.
 */
import { z } from 'zod';

import { PLAYER_COLOR_VALUES } from '@/shared/player-colors';
import type { BookSong } from '@/types/firesong/BookSong';
import type { CalibrationFailure } from '@/types/firesong/CalibrationFailure';
import type { CalibrationState } from '@/types/firesong/CalibrationState';
import type { FxSound } from '@/types/firesong/FxSound';
import type { IceCandidate } from '@/types/firesong/IceCandidate';
import type { IceServer } from '@/types/firesong/IceServer';
import type { LatencyMethod } from '@/types/firesong/LatencyMethod';
import type { MicLink } from '@/types/firesong/MicLink';
import type { MicLinks } from '@/types/firesong/MicLinks';
import type { MicPartyToServer } from '@/types/firesong/MicPartyToServer';
import type { MicToServer } from '@/types/firesong/MicToServer';
import type { MuteSource } from '@/types/firesong/MuteSource';
import type { NightScore } from '@/types/firesong/NightScore';
import type { NoticeCode } from '@/types/firesong/NoticeCode';
import type { PartyAction } from '@/types/firesong/PartyAction';
import type { PartyErrorCode } from '@/types/firesong/PartyErrorCode';
import type { PartyItem } from '@/types/firesong/PartyItem';
import type { PartySinger } from '@/types/firesong/PartySinger';
import type { PartySnapshot } from '@/types/firesong/PartySnapshot';
import type { PartyStage } from '@/types/firesong/PartyStage';
import type { PrepStage } from '@/types/firesong/PrepStage';
import type { PrepState } from '@/types/firesong/PrepState';
import type { RtcErrorCode } from '@/types/firesong/RtcErrorCode';
import type { ScoreTier } from '@/types/firesong/ScoreTier';
import type { ServerToMic } from '@/types/firesong/ServerToMic';
import type { ServerToMicParty } from '@/types/firesong/ServerToMicParty';
import type { ServerToTv } from '@/types/firesong/ServerToTv';
import type { ServerToTvParty } from '@/types/firesong/ServerToTvParty';
import type { SlotLostReason } from '@/types/firesong/SlotLostReason';
import type { SlotResult } from '@/types/firesong/SlotResult';
import type { SlotState } from '@/types/firesong/SlotState';
import type { SongBookPage } from '@/types/firesong/SongBookPage';
import type { SongBookQuery } from '@/types/firesong/SongBookQuery';
import type { StageKind } from '@/types/firesong/StageKind';
import type { TvPartyToServer } from '@/types/firesong/TvPartyToServer';
import type { TvSlot } from '@/types/firesong/TvSlot';
import type { TvToServer } from '@/types/firesong/TvToServer';
import type { PlayerColor } from '@/types/PlayerColor';

export type {
  BookSong,
  CalibrationFailure,
  CalibrationState,
  FxSound,
  IceCandidate,
  IceServer,
  LatencyMethod,
  MicLink,
  MicLinks,
  MicPartyToServer,
  MicToServer,
  MuteSource,
  NightScore,
  NoticeCode,
  PartyAction,
  PartyErrorCode,
  PartyItem,
  PartySinger,
  PartySnapshot,
  PartyStage,
  PrepStage,
  PrepState,
  RtcErrorCode,
  ScoreTier,
  ServerToMic,
  ServerToMicParty,
  ServerToTv,
  ServerToTvParty,
  SlotLostReason,
  SlotResult,
  SlotState,
  SongBookPage,
  SongBookQuery,
  StageKind,
  TvPartyToServer,
  TvSlot,
  TvToServer,
};

export const PROTOCOL_VERSION = 1;
export const RTC_PATH = '/rtc';
export const MIC_PAGE_PATH = '/m';
export const MIC_LINKS_PATH = '/api/firesong/mic-links';

export const SLOT_COUNT = 4;
export const RESERVATION_SECS = 600;
export const PING_INTERVAL_SECS = 5;
export const IDLE_TIMEOUT_SECS = 15;
export const HELLO_TIMEOUT_SECS = 5;

export const MAX_FRAME_BYTES = 65_536;
export const MAX_SDP_BYTES = 32_768;
export const MAX_CANDIDATE_BYTES = 1_024;
export const MAX_DIAG_BYTES = 8_192;
export const MAX_NAME_CHARS = 32;
export const MAX_LATENCY_MS = 1_000;
export const MAX_TITLE_CHARS = 200;
export const MAX_DISPLAY_SCORE = 100;
export const MAX_RAW_SCORE = 1_000;

/** Party channel (PROTOCOL.md §13); each value mirrors `remote_mic.rs`. */
export const SONG_BOOK_COMMAND = 'firesong_song_book';
export const MAX_RESERVATIONS_PER_SLOT = 3;
export const MAX_PREPARING_PER_SLOT = 2;
export const MAX_PREPARING_TOTAL = 6;
export const MAX_SING_NEXT_PER_SLOT = 1;
export const MAX_PARTNERS = 3;
export const MAX_PARTY_QUEUE_ITEMS = 30;
export const MAX_NIGHT_SCORES = 10;
export const NIGHT_SCORE_MAX_AGE_SECS = 43_200;
export const MAX_LYRIC_CHARS = 200;
export const MAX_LINE_MS = 60_000;
export const MAX_COUNTDOWN_SECS = 120;
export const MIN_KEY_OFFSET = -5;
export const MAX_KEY_OFFSET = 5;
export const MIN_TEMPO = 0.5;
export const MAX_TEMPO = 2;
export const TEMPO_STEP = 0.1;
export const DEFAULT_VOLUME_PCT = 100;
export const MAX_VOLUME_PCT = 150;
export const DEFAULT_ECHO_PCT = 100;
export const MAX_ECHO_PCT = 200;
export const MAX_SEARCH_CHARS = 100;
export const MAX_BOOK_PAGE = 50;
export const PARTY_REQUEST_BURST = 6;
export const PARTY_REQUEST_REFILL_MS = 3_000;
export const FX_BURST = 3;
export const FX_REFILL_MS = 2_000;
export const MAX_FX_VOICES = 4;
export const MIX_PER_SEC = 5;
export const CALIBRATION_COOLDOWN_SECS = 30;
export const CALIBRATION_TIMEOUT_SECS = 15;
export const SHIFT_CURRENT_COOLDOWN_SECS = 15;
export const MAX_SHIFTS_PER_SONG = 3;
export const LOBBY_COUNTDOWN_SECS = 15;
export const ABSENT_SINGER_GRACE_SECS = 30;

export const isValidKeyOffset = (keyOffset: number): boolean =>
  Number.isInteger(keyOffset) && keyOffset >= MIN_KEY_OFFSET && keyOffset <= MAX_KEY_OFFSET;

/** A tempo ratio from {@link MIN_TEMPO} to {@link MAX_TEMPO} in {@link TEMPO_STEP} steps. */
export const isValidTempo = (tempo: number): boolean => {
  const epsilon = 1e-6;
  const steps = tempo / TEMPO_STEP;
  return (
    Number.isFinite(tempo) &&
    tempo >= MIN_TEMPO - epsilon &&
    tempo <= MAX_TEMPO + epsilon &&
    Math.abs(steps - Math.round(steps)) < epsilon
  );
};

export const CLOSE_CODE = {
  badRequest: 4400,
  badResume: 4403,
  timeout: 4408,
  replaced: 4409,
  kicked: 4410,
  tooLarge: 4413,
  rateLimited: 4429,
  slotsFull: 4503,
} as const;

/** After these closes a phone must not reconnect on its own. */
export const NO_RECONNECT_CLOSE_CODES: readonly number[] = [CLOSE_CODE.replaced, CLOSE_CODE.kicked];

/** localStorage key on the phone for {@link StoredMicIdentity}. */
export const MIC_IDENTITY_STORAGE_KEY = 'firesong.mic';

export type StoredMicIdentity = {
  micId: string;
  resumeKey?: string;
  slot?: MicSlot;
};

export type MicSlot = 1 | 2 | 3 | 4;

export const MIC_SLOTS: readonly MicSlot[] = [1, 2, 3, 4];

export const isMicSlot = (value: unknown): value is MicSlot =>
  typeof value === 'number' && MIC_SLOTS.some((slot) => slot === value);

/** Slot N always has player colour N, so QR codes, badges and players agree. */
export const slotColor = (slot: MicSlot): PlayerColor => PLAYER_COLOR_VALUES[slot - 1];

const MIC_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export const isValidMicId = (micId: string): boolean => MIC_ID_PATTERN.test(micId);

/** Phone microphones appear to the `MicrophoneAdapter` under this prefix. */
export const REMOTE_MIC_DEVICE_PREFIX = 'remote:';

/** `MicrophoneInfo.host` of phone microphones. */
export const REMOTE_MIC_HOST = 'FireSong';

export const remoteMicDeviceId = (micId: string): string => `${REMOTE_MIC_DEVICE_PREFIX}${micId}`;

/** The `micId` of a `remote:<micId>` device id, or `null` for local devices. */
export const parseRemoteMicDeviceId = (deviceId: string | null | undefined): string | null => {
  if (typeof deviceId !== 'string' || !deviceId.startsWith(REMOTE_MIC_DEVICE_PREFIX)) {
    return null;
  }
  const micId = deviceId.slice(REMOTE_MIC_DEVICE_PREFIX.length);
  return isValidMicId(micId) ? micId : null;
};

export const isRemoteMicDeviceId = (deviceId: string | null | undefined): boolean =>
  parseRemoteMicDeviceId(deviceId) !== null;

export const scoreTierFor = (displayScore: number): ScoreTier => {
  if (displayScore >= 100) {
    return 'perfect';
  }
  if (displayScore >= 90) {
    return 'excellent';
  }
  if (displayScore >= 80) {
    return 'great';
  }
  return displayScore >= 70 ? 'good' : 'retry';
};

const slotSchema = z.number().int().min(1).max(SLOT_COUNT);
const playerColorSchema = z.enum(PLAYER_COLOR_VALUES);
const muteSourceSchema = z.enum(['mic', 'tv']);
const slotStateSchema = z.enum(['empty', 'connected', 'reserved']);
const latencyMethodSchema = z.enum(['beep', 'stats', 'manual']);
const scoreTierSchema = z.enum(['perfect', 'excellent', 'great', 'good', 'retry']);
const slotLostReasonSchema = z.enum([
  'disconnected',
  'bye',
  'expired',
  'evicted',
  'kicked',
  'replaced',
]);
const errorCodeSchema = z.enum([
  'bad-frame',
  'bad-hello',
  'no-hello',
  'version',
  'slots-full',
  'bad-resume',
  'no-tv',
  'unknown-slot',
  'too-large',
  'rate-limited',
  'tv-replaced',
]);

const iceCandidateSchema = z.object({
  candidate: z.string(),
  sdpMid: z.string().nullish(),
  sdpMLineIndex: z.number().int().nullish(),
  usernameFragment: z.string().nullish(),
});

const iceServerSchema = z.object({
  urls: z.array(z.string()),
  username: z.string().optional(),
  credential: z.string().optional(),
});

const tvSlotSchema = z.object({
  slot: slotSchema,
  color: playerColorSchema,
  state: slotStateSchema,
  micId: z.string().optional(),
  name: z.string().optional(),
  muted: z.boolean(),
  latencyMs: z.number().optional(),
  latencyMethod: latencyMethodSchema.optional(),
  reservedForSecs: z.number().optional(),
});

const errorFrameSchema = z.object({
  type: z.literal('error'),
  code: errorCodeSchema,
  message: z.string().optional(),
});

/** A phone's error; with `slots-full`, its place in the line for a free mic. */
const micErrorFrameSchema = errorFrameSchema.extend({
  position: z.number().int().min(1).optional(),
});

const pongFrameSchema = z.object({ type: z.literal('pong'), t: z.number() });

const serverToMicSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('assign'),
    v: z.number(),
    slot: slotSchema,
    color: playerColorSchema,
    micId: z.string(),
    resumeKey: z.string(),
    reclaimed: z.boolean(),
    tvConnected: z.boolean(),
    iceServers: z.array(iceServerSchema),
  }),
  z.object({ type: z.literal('answer'), sdp: z.string() }),
  z.object({ type: z.literal('ice'), candidate: iceCandidateSchema.nullable() }),
  z.object({ type: z.literal('restart') }),
  z.object({ type: z.literal('mute'), muted: z.boolean(), by: muteSourceSchema }),
  z.object({ type: z.literal('tv-state'), connected: z.boolean() }),
  z.object({
    type: z.literal('song-result'),
    displayScore: z.number(),
    rawScore: z.number(),
    tier: scoreTierSchema,
    rank: z.number().optional(),
    singers: z.number().optional(),
    title: z.string().optional(),
  }),
  z.object({ type: z.literal('slot-lost'), reason: slotLostReasonSchema }),
  micErrorFrameSchema,
  pongFrameSchema,
]);

const serverToTvSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), v: z.number(), iceServers: z.array(iceServerSchema) }),
  z.object({ type: z.literal('roster'), slots: z.array(tvSlotSchema) }),
  z.object({
    type: z.literal('offer'),
    slot: slotSchema,
    micId: z.string(),
    sdp: z.string(),
    restart: z.boolean(),
  }),
  z.object({
    type: z.literal('ice'),
    slot: slotSchema,
    micId: z.string(),
    candidate: iceCandidateSchema.nullable(),
  }),
  z.object({ type: z.literal('mute'), slot: slotSchema, muted: z.boolean(), by: muteSourceSchema }),
  z.object({
    type: z.literal('diag'),
    slot: slotSchema,
    micId: z.string(),
    data: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('slot-lost'),
    slot: slotSchema,
    micId: z.string(),
    reason: slotLostReasonSchema,
  }),
  errorFrameSchema,
  pongFrameSchema,
]);

const micLinksSchema = z.object({
  slots: z.array(
    z.object({
      slot: slotSchema,
      color: playerColorSchema,
      url: z.string().nullable(),
      qrSvg: z.string().nullable(),
    }),
  ),
});

const keyOffsetSchema = z.number().int().min(MIN_KEY_OFFSET).max(MAX_KEY_OFFSET);
const tempoSchema = z.number().min(MIN_TEMPO).max(MAX_TEMPO);
const partyActionSchema = z.enum(['pause', 'resume', 'stop', 'start-now']);
const fxSoundSchema = z.enum(['applause', 'tambourine', 'cheer', 'air-horn']);
const stageKindSchema = z.enum(['lobby', 'starting', 'singing', 'paused', 'reveal']);
const prepStageSchema = z.enum([
  'ready',
  'not-ready',
  'queued',
  'analyzing',
  'waiting-gpu',
  'failed',
]);
const calibrationStateSchema = z.enum(['started', 'done', 'failed']);
const calibrationFailureSchema = z.enum(['busy', 'no-audio', 'no-tone', 'timeout', 'no-tv']);
const partyErrorCodeSchema = z.enum([
  'not-allowed',
  'not-found',
  'invalid',
  'limit-reservations',
  'limit-preparing',
  'prep-full',
  'limit-sing-next',
  'duplicate',
  'song-full',
  'busy',
  'no-tv',
  'unavailable',
  'rate-limited',
]);
const noticeCodeSchema = z.enum([
  'duet-added',
  'partner-joined',
  'partner-left',
  'prep-failed',
  'passed-over',
  'shift-failed',
  'start-failed',
]);

const prepStateSchema = z.object({
  state: prepStageSchema,
  pct: z.number().int().min(0).max(100).optional(),
  etaSecs: z.number().int().min(0).optional(),
});

const partyItemSchema = z.object({
  reservationId: z.string().min(1),
  entryId: z.string().min(1).optional(),
  fileHash: z.string().min(1),
  title: z.string(),
  artist: z.string(),
  durationSecs: z.number().min(0),
  singers: z.array(slotSchema).max(SLOT_COUNT),
  keyOffset: keyOffsetSchema,
  tempo: tempoSchema,
  singNext: z.boolean(),
  shiftable: z.boolean(),
  prep: prepStateSchema,
});

const partySingerSchema = z.object({
  slot: slotSchema,
  color: playerColorSchema,
  name: z.string().optional(),
  state: slotStateSchema,
  volumePct: z.number().int().min(0).max(MAX_VOLUME_PCT),
  echoPct: z.number().int().min(0).max(MAX_ECHO_PCT),
});

const nightScoreSchema = z.object({
  slot: slotSchema,
  color: playerColorSchema,
  name: z.string().optional(),
  title: z.string().optional(),
  displayScore: z.number().int().min(0).max(MAX_DISPLAY_SCORE),
  rawScore: z.number().int().min(0).max(MAX_RAW_SCORE),
  tier: scoreTierSchema,
  atSecs: z.number().int().min(0),
});

const partyStageSchema = z.object({
  state: stageKindSchema,
  reservationId: z.string().min(1).optional(),
  title: z.string().optional(),
  artist: z.string().optional(),
  singers: z.array(slotSchema).max(SLOT_COUNT),
  countdownSecs: z.number().int().min(0).max(MAX_COUNTDOWN_SECS).optional(),
});

const partySnapshotSchema = z.object({
  rev: z.number().int().min(0),
  tvConnected: z.boolean(),
  stage: partyStageSchema,
  queue: z.array(partyItemSchema),
  queueTotal: z.number().int().min(0),
  singers: z.array(partySingerSchema).max(SLOT_COUNT),
  scores: z.array(nightScoreSchema).max(MAX_NIGHT_SCORES),
  waiting: z.number().int().min(0).default(0),
});

const partyFrameSchema = z.object({ type: z.literal('party'), party: partySnapshotSchema });

const serverToMicPartySchema = z.discriminatedUnion('type', [
  partyFrameSchema,
  z.object({
    type: z.literal('ack'),
    reqId: z.number().int().min(0),
    ok: z.boolean(),
    code: partyErrorCodeSchema.optional(),
    reservationId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('lyric'),
    line: z.string().optional(),
    next: z.string().optional(),
    lineMs: z.number().int().min(0).max(MAX_LINE_MS).optional(),
    elapsedMs: z.number().int().min(0).max(MAX_LINE_MS).optional(),
    paused: z.boolean(),
  }),
  z.object({
    type: z.literal('calibration'),
    state: calibrationStateSchema,
    latencyMs: z.number().int().min(0).max(MAX_LATENCY_MS).optional(),
    reason: calibrationFailureSchema.optional(),
  }),
  z.object({
    type: z.literal('notice'),
    code: noticeCodeSchema,
    title: z.string().optional(),
    bySlot: slotSchema.optional(),
  }),
  z.object({
    type: z.literal('night-rank'),
    rank: z.number().int().min(1).max(MAX_NIGHT_SCORES).optional(),
    entries: z.number().int().min(0),
  }),
]);

const serverToTvPartySchema = z.discriminatedUnion('type', [
  partyFrameSchema,
  z.object({
    type: z.literal('control'),
    slot: slotSchema,
    micId: z.string(),
    action: partyActionSchema,
  }),
  z.object({
    type: z.literal('shift-current'),
    slot: slotSchema,
    micId: z.string(),
    keyOffset: keyOffsetSchema,
    tempo: tempoSchema,
  }),
  z.object({ type: z.literal('fx'), slot: slotSchema, sound: fxSoundSchema }),
  z.object({
    type: z.literal('mix'),
    slot: slotSchema,
    volumePct: z.number().int().min(0).max(MAX_VOLUME_PCT),
    echoPct: z.number().int().min(0).max(MAX_ECHO_PCT),
  }),
  z.object({ type: z.literal('calibrate'), slot: slotSchema, micId: z.string() }),
]);

const bookSongSchema = z.object({
  fileHash: z.string().min(1),
  title: z.string(),
  artist: z.string(),
  durationSecs: z.number().min(0),
  shiftable: z.boolean(),
  prep: prepStateSchema,
});

const songBookPageSchema = z.object({
  items: z.array(bookSongSchema).max(MAX_BOOK_PAGE),
  skip: z.number().int().min(0),
  total: z.number().int().min(0),
  readyTotal: z.number().int().min(0),
});

type Assignable<A, B> = [A] extends [B] ? true : false;
type KeysOfMembers<T> = T extends unknown ? keyof T : never;
type SameShape<A, B> =
  Assignable<A, B> extends true
    ? Assignable<B, A> extends true
      ? Assignable<[KeysOfMembers<A>], [KeysOfMembers<B>]> extends true
        ? Assignable<[KeysOfMembers<B>], [KeysOfMembers<A>]>
        : false
      : false
    : false;
type Expect<T extends true> = T;
type SchemaOf<S extends z.ZodType> = z.infer<S>;

/**
 * Compile-time proof that the validators accept the generated wire types
 * field for field; `pnpm typecheck` fails when `remote_mic.rs` changes alone.
 */
export type ProtocolSchemasMatchRust = [
  Expect<SameShape<SchemaOf<typeof serverToMicSchema>, ServerToMic>>,
  Expect<SameShape<SchemaOf<typeof serverToTvSchema>, ServerToTv>>,
  Expect<SameShape<SchemaOf<typeof tvSlotSchema>, TvSlot>>,
  Expect<SameShape<SchemaOf<typeof iceCandidateSchema>, IceCandidate>>,
  Expect<SameShape<SchemaOf<typeof iceServerSchema>, IceServer>>,
  Expect<SameShape<SchemaOf<typeof micLinksSchema>, MicLinks>>,
  Expect<SameShape<SchemaOf<typeof micLinksSchema>['slots'][number], MicLink>>,
  Expect<SameShape<SchemaOf<typeof serverToMicPartySchema>, ServerToMicParty>>,
  Expect<SameShape<SchemaOf<typeof serverToTvPartySchema>, ServerToTvParty>>,
  Expect<SameShape<SchemaOf<typeof partySnapshotSchema>, PartySnapshot>>,
  Expect<SameShape<SchemaOf<typeof partyStageSchema>, PartyStage>>,
  Expect<SameShape<SchemaOf<typeof partyItemSchema>, PartyItem>>,
  Expect<SameShape<SchemaOf<typeof partySingerSchema>, PartySinger>>,
  Expect<SameShape<SchemaOf<typeof nightScoreSchema>, NightScore>>,
  Expect<SameShape<SchemaOf<typeof prepStateSchema>, PrepState>>,
  Expect<SameShape<SchemaOf<typeof songBookPageSchema>, SongBookPage>>,
  Expect<SameShape<SchemaOf<typeof bookSongSchema>, BookSong>>,
];

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/** A validated server frame for the phone, or `null` for anything else. */
export const parseServerToMic = (raw: string): ServerToMic | null => {
  const parsed = serverToMicSchema.safeParse(parseJson(raw));
  return parsed.success ? parsed.data : null;
};

/** A validated server frame for the TV, or `null` for anything else. */
export const parseServerToTv = (raw: string): ServerToTv | null => {
  const parsed = serverToTvSchema.safeParse(parseJson(raw));
  return parsed.success ? parsed.data : null;
};

export const parseMicLinks = (value: unknown): MicLinks => micLinksSchema.parse(value);

/**
 * A validated party frame for the phone, or `null` for anything else. A frame
 * is either signaling or party, so try {@link parseServerToMic} first.
 */
export const parseServerToMicParty = (raw: string): ServerToMicParty | null => {
  const parsed = serverToMicPartySchema.safeParse(parseJson(raw));
  return parsed.success ? parsed.data : null;
};

/** A validated party frame for the TV, or `null` for anything else. */
export const parseServerToTvParty = (raw: string): ServerToTvParty | null => {
  const parsed = serverToTvPartySchema.safeParse(parseJson(raw));
  return parsed.success ? parsed.data : null;
};

/** The result of {@link SONG_BOOK_COMMAND}; throws on anything else. */
export const parseSongBookPage = (value: unknown): SongBookPage => songBookPageSchema.parse(value);

/** Serialises one outbound frame; the type keeps phone and TV frames apart. */
export const encodeFrame = (
  frame: MicToServer | MicPartyToServer | TvToServer | TvPartyToServer,
): string => JSON.stringify(frame);
