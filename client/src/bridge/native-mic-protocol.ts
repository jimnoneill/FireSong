import { z } from 'zod';

import {
  isMicSlot,
  type IceCandidate,
  type IceServer,
  type MicSlot,
} from '@/features/remote-mic/protocol';

/**
 * The mics protocol (version 2) between the TV page and the FireSong TV app's
 * voice engine, over the loopback door of `native-voice.ts`. The page sends
 * JSON text frames (`PageMessage`); the app answers with JSON text frames
 * (`AppMessage`) and binary tap messages: each phone's voice after its gate
 * and level, for pitch and scoring.
 */
export const NATIVE_RATE = 48_000;
export const NATIVE_FEATURES = ['mics'] as const;
export const TAP_FRAMES = 512;
export const TAP_BLOCK_BYTES = 2056;

const TAP_VERSION = 1;
const TAP_KIND = 1;
const TAP_HEADER_BYTES = 4;
const TAP_BLOCK_HEADER_BYTES = 8;
const TAP_MAX_BLOCKS = 31;

export type PageMessage =
  | { t: 'hello'; v: 2; features: readonly string[] }
  | {
      t: 'offer';
      peer: number;
      seq: number;
      slot: MicSlot;
      micId: string;
      sdp: string;
      iceServers: readonly IceServer[];
    }
  | { t: 'ice'; peer: number; candidate: IceCandidate | null }
  | { t: 'close'; peer: number }
  | { t: 'detach' | 'release'; slot: MicSlot }
  | { t: 'monitor'; slot: MicSlot; on: boolean }
  | { t: 'mute'; slot: MicSlot; muted: boolean }
  | { t: 'mix'; slot: MicSlot; volume: number; echo: number }
  | { t: 'tap'; slot: MicSlot; on: boolean }
  | { t: 'echo-mix'; wet: number; feedback: number; lowpassHz: number; reverbSend: number }
  | { t: 'measure-monitor'; id: number; slot: MicSlot };

const slotSchema = z.literal([1, 2, 3, 4]);
const peerSchema = z.number().int().positive();
const countSchema = z.number();

const readySchema = z.discriminatedUnion('ok', [
  z.object({
    t: z.literal('ready'),
    v: z.literal(2),
    ok: z.literal(true),
    features: z.array(z.string()),
    audio: z.enum(['open', 'pending']),
    rate: z.literal(NATIVE_RATE),
    burstFrames: z.number().int().nullable(),
    outputLatencyMs: z.number().nullable(),
  }),
  z.object({
    t: z.literal('ready'),
    v: z.literal(2),
    ok: z.literal(false),
    reason: z.enum(['lib', 'webrtc']),
  }),
]);

const slotStatusSchema = z.object({
  slot: slotSchema,
  attached: z.boolean(),
  monitored: z.boolean(),
  muted: z.boolean(),
  levelRms: z.number(),
  gateOpen: z.boolean(),
  gateThreshold: z.number(),
  feedbackHz: z.number().nullable(),
  boostDb: z.number(),
  echo: z.object({
    delayMs: z.number(),
    dryGain: z.number(),
    wetGain: z.number(),
    late: z.boolean(),
  }),
  mix: z.object({ volume: z.number(), echo: z.number() }),
  fillMs: z.number(),
  outRms: z.number(),
  monitorMs: z.number().nullable(),
});

const engineStatsSchema = z.object({
  t: z.literal('engine-stats'),
  open: z.boolean(),
  outputLatencyMs: z.number().nullable(),
  burstFrames: countSchema,
  bufferFrames: countSchema,
  xruns: countSchema,
  restarts: countSchema,
  openAttempts: countSchema,
  callbackP99Us: countSchema,
  callbackMaxUs: countSchema,
  pushIntervalP50Us: countSchema,
  pushIntervalP99Us: countSchema,
  pushIntervalMaxUs: countSchema,
  pushToPresentP50Ms: z.number(),
  pushToPresentP95Ms: z.number(),
  tapDropped: countSchema,
  tapDrainP99Us: countSchema,
  tapDrainMaxUs: countSchema,
  peak: z.number(),
  sinkErrors: countSchema,
  ignored: countSchema,
  apm: z.string().nullable(),
  slots: z.array(
    z.object({
      slot: slotSchema,
      underruns: countSchema,
      trimmedFrames: countSchema,
      marginMs: z.number(),
    }),
  ),
});

const monitorResultSchema = z.discriminatedUnion('ok', [
  z.object({
    t: z.literal('monitor-result'),
    id: z.number().int(),
    slot: slotSchema,
    ok: z.literal(true),
    monitorMs: z.number(),
  }),
  z.object({
    t: z.literal('monitor-result'),
    id: z.number().int(),
    slot: slotSchema,
    ok: z.literal(false),
    reason: z.enum(['busy', 'no-audio', 'no-tone', 'stopped']),
  }),
]);

export const appMessageSchema = z.discriminatedUnion('t', [
  readySchema,
  z.object({ t: z.literal('answer'), peer: peerSchema, seq: z.number().int(), sdp: z.string() }),
  z.object({
    t: z.literal('peer-error'),
    peer: peerSchema,
    seq: z.number().int(),
    code: z.enum(['sdp', 'timeout', 'internal', 'superseded']),
    detail: z.string().max(200),
  }),
  z.object({ t: z.literal('restart-needed'), peer: peerSchema }),
  z.object({
    t: z.literal('peer-stats'),
    peer: peerSchema,
    jitterBufferDelay: z.number(),
    jitterBufferEmittedCount: z.number(),
    jitterBufferTargetDelay: z.number(),
    packetsReceived: countSchema,
    packetsLost: countSchema,
    concealedSamples: countSchema,
    concealmentEvents: countSchema,
    insertedSamplesForDeceleration: countSchema,
    removedSamplesForAcceleration: countSchema,
    jitter: z.number(),
    roundTripTimeMs: z.number().nullable(),
    candidateType: z.enum(['host', 'srflx', 'prflx', 'relay']).nullable(),
  }),
  z.object({ t: z.literal('status'), slots: z.array(slotStatusSchema) }),
  engineStatsSchema,
  monitorResultSchema,
  z.object({ t: z.literal('fatal'), reason: z.enum(['webrtc', 'internal']) }),
]);

export type AppMessage = z.infer<typeof appMessageSchema>;
export type ReadyOk = Extract<AppMessage, { t: 'ready'; ok: true }>;
export type NativeSlotStatus = Extract<AppMessage, { t: 'status' }>['slots'][number];
export type EngineStats = Extract<AppMessage, { t: 'engine-stats' }>;

/** `flags` bit 0: a silent block sent after the slot was detached. */
export type TapBlock = { slot: MicSlot; flags: number; seq: number; samples: Float32Array };

/**
 * The blocks of one binary tap message, viewing the samples in place; null
 * when the header is not version 1 / kind 1 or the length does not match count.
 */
export const parseTapMessage = (data: ArrayBuffer): TapBlock[] | null => {
  if (data.byteLength < TAP_HEADER_BYTES) {
    return null;
  }
  const view = new DataView(data);
  const count = view.getUint16(2, true);
  if (
    view.getUint8(0) !== TAP_VERSION ||
    view.getUint8(1) !== TAP_KIND ||
    count < 1 ||
    count > TAP_MAX_BLOCKS ||
    data.byteLength !== TAP_HEADER_BYTES + count * TAP_BLOCK_BYTES
  ) {
    return null;
  }
  const blocks: TapBlock[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = TAP_HEADER_BYTES + index * TAP_BLOCK_BYTES;
    const slot = view.getUint8(offset);
    if (!isMicSlot(slot) || view.getUint16(offset + 2, true) !== TAP_FRAMES) {
      return null;
    }
    blocks.push({
      slot,
      flags: view.getUint8(offset + 1),
      seq: view.getUint32(offset + 4, true),
      samples: new Float32Array(data, offset + TAP_BLOCK_HEADER_BYTES, TAP_FRAMES),
    });
  }
  return blocks;
};

export type NativeMicLinkPort = {
  readonly ready: ReadyOk;
  send(message: PageMessage): boolean;
  subscribe(listener: (message: AppMessage) => void): () => void;
  onTap(listener: (block: TapBlock) => void): () => void;
  /** Called once when the link dies after `ready` (close, error, `fatal`, 5 s of silence, 20 s without audio). */
  onLost(listener: (why: string) => void): () => void;
  latestEngineStats(): EngineStats | null;
  /** Page-side tap message arrival intervals since the last call (report only). */
  tapArrival(): { p99Ms: number; maxMs: number; count: number } | null;
  close(): void;
};
