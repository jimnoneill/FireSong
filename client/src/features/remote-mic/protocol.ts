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
import type { IceCandidate } from '@/types/firesong/IceCandidate';
import type { IceServer } from '@/types/firesong/IceServer';
import type { LatencyMethod } from '@/types/firesong/LatencyMethod';
import type { MicLink } from '@/types/firesong/MicLink';
import type { MicLinks } from '@/types/firesong/MicLinks';
import type { MicToServer } from '@/types/firesong/MicToServer';
import type { MuteSource } from '@/types/firesong/MuteSource';
import type { RtcErrorCode } from '@/types/firesong/RtcErrorCode';
import type { ScoreTier } from '@/types/firesong/ScoreTier';
import type { ServerToMic } from '@/types/firesong/ServerToMic';
import type { ServerToTv } from '@/types/firesong/ServerToTv';
import type { SlotLostReason } from '@/types/firesong/SlotLostReason';
import type { SlotResult } from '@/types/firesong/SlotResult';
import type { SlotState } from '@/types/firesong/SlotState';
import type { TvSlot } from '@/types/firesong/TvSlot';
import type { TvToServer } from '@/types/firesong/TvToServer';
import type { PlayerColor } from '@/types/PlayerColor';

export type {
  IceCandidate,
  IceServer,
  LatencyMethod,
  MicLink,
  MicLinks,
  MicToServer,
  MuteSource,
  RtcErrorCode,
  ScoreTier,
  ServerToMic,
  ServerToTv,
  SlotLostReason,
  SlotResult,
  SlotState,
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
  errorFrameSchema,
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

/** Serialises one outbound frame; the type keeps phone and TV frames apart. */
export const encodeFrame = (frame: MicToServer | TvToServer): string => JSON.stringify(frame);
