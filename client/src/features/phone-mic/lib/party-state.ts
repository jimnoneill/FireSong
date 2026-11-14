import {
  CALIBRATION_COOLDOWN_SECS,
  FX_BURST,
  FX_REFILL_MS,
  isMicSlot,
  type CalibrationFailure,
  type MicSlot,
  type NoticeCode,
  type PartyErrorCode,
  type PartyItem,
  type PartySnapshot,
  type ServerToMicParty,
} from '@/features/remote-mic/protocol';

import { fullBucket, takeToken, type BucketRule, type TokenBucket } from './budget';

export type PartyRequestKind =
  | 'reserve'
  | 'edit'
  | 'cancel'
  | 'control'
  | 'shift-current'
  | 'calibrate'
  | 'fx';

/** Why a request did not go through: an `ack` code, no `ack` in time, or no socket. */
export type RequestFailureCode = PartyErrorCode | 'no-ack' | 'offline';

/** Key and tempo of a `shift-current`, kept for the song it was sent for. */
export type ShiftValues = { keyOffset: number; tempo: number };

export type PendingRequest = {
  reqId: number;
  kind: PartyRequestKind;
  sentAt: number;
  shift?: ShiftValues & { songKey: string };
};

export type PartyMessage =
  | { id: number; kind: 'notice'; code: NoticeCode; title?: string; bySlot?: MicSlot }
  | { id: number; kind: 'failure'; request: PartyRequestKind; code: RequestFailureCode };

export type LyricView = {
  line: string;
  next?: string;
  lineMs?: number;
  elapsedMs?: number;
  paused: boolean;
  /** Wall clock when the frame arrived, in ms. */
  receivedAt: number;
};

export type CalibrationView =
  | { state: 'idle' }
  | { state: 'requested' }
  | { state: 'started' }
  | { state: 'done'; latencyMs?: number }
  | { state: 'failed'; reason?: CalibrationFailure | RequestFailureCode };

export type NightRankView = { rank?: number; entries: number };

/** Shifts accepted for one song: 15 s apart and at most 3 (PROTOCOL.md §13.10). */
export type ShiftRecord = { songKey: string; count: number; lastAt: number; applied: ShiftValues };

export type MixValues = { volumePct?: number; echoPct?: number };

export type PartyState = {
  snapshot: PartySnapshot | null;
  /** Wall clock when `snapshot` arrived, in ms; the lobby countdown runs from it. */
  snapshotAt: number;
  /** The latest copy of recently seen items; the current song has left `queue` but keeps its key and tempo here. */
  recentItems: readonly PartyItem[];
  pending: readonly PendingRequest[];
  messages: readonly PartyMessage[];
  nextMessageId: number;
  lyric: LyricView | null;
  calibration: CalibrationView;
  calibrateSentAt: number | null;
  nightRank: NightRankView | null;
  fx: TokenBucket;
  shift: ShiftRecord | null;
  /** Mixer values sent but maybe not yet in a snapshot, so the sliders do not jump back. */
  mixDraft: MixValues;
};

export type PartyEvent =
  | { type: 'frame'; frame: ServerToMicParty; at: number }
  | { type: 'sent'; request: PendingRequest }
  | { type: 'not-sent'; kind: PartyRequestKind }
  | { type: 'ack-timeout'; reqId: number }
  | { type: 'fx'; at: number }
  | { type: 'mix-draft'; values: MixValues }
  | { type: 'mix-settled' }
  | { type: 'dismiss'; id: number }
  | { type: 'song-result' }
  | { type: 'reset'; at: number };

export const FX_RULE: BucketRule = { burst: FX_BURST, refillMs: FX_REFILL_MS };
export const CALIBRATE_COOLDOWN_MS = CALIBRATION_COOLDOWN_SECS * 1_000;
const MAX_MESSAGES = 3;
const MAX_RECENT_ITEMS = 40;

export const initialPartyState = (now: number): PartyState => ({
  snapshot: null,
  snapshotAt: now,
  recentItems: [],
  pending: [],
  messages: [],
  nextMessageId: 1,
  lyric: null,
  calibration: { state: 'idle' },
  calibrateSentAt: null,
  nightRank: null,
  fx: fullBucket(FX_RULE, now),
  shift: null,
  mixDraft: {},
});

type MessageBody =
  | { kind: 'notice'; code: NoticeCode; title?: string; bySlot?: MicSlot }
  | { kind: 'failure'; request: PartyRequestKind; code: RequestFailureCode };

const withMessage = (state: PartyState, body: MessageBody): PartyState => ({
  ...state,
  messages: [...state.messages, { ...body, id: state.nextMessageId }].slice(-MAX_MESSAGES),
  nextMessageId: state.nextMessageId + 1,
});

const withFailure = (
  state: PartyState,
  request: PartyRequestKind,
  code: RequestFailureCode,
): PartyState => {
  const failed = withMessage(state, { kind: 'failure', request, code });
  return request === 'calibrate'
    ? { ...failed, calibration: { state: 'failed', reason: code } }
    : failed;
};

const mergeRecent = (
  queue: readonly PartyItem[],
  recent: readonly PartyItem[],
): readonly PartyItem[] => {
  const ids = new Set(queue.map((item) => item.reservationId));
  return [...queue, ...recent.filter((item) => !ids.has(item.reservationId))].slice(
    0,
    MAX_RECENT_ITEMS,
  );
};

const LYRIC_STAGES: ReadonlySet<string> = new Set(['starting', 'singing', 'paused']);

const applySnapshot = (state: PartyState, snapshot: PartySnapshot, at: number): PartyState => ({
  ...state,
  snapshot,
  snapshotAt: at,
  recentItems: mergeRecent(snapshot.queue, state.recentItems),
  lyric: LYRIC_STAGES.has(snapshot.stage.state) ? state.lyric : null,
});

const applyShift = (state: PartyState, request: PendingRequest, at: number): PartyState => {
  const shift = request.shift;
  if (shift === undefined) {
    return state;
  }
  const count = state.shift?.songKey === shift.songKey ? state.shift.count + 1 : 1;
  return {
    ...state,
    shift: {
      songKey: shift.songKey,
      count,
      lastAt: at,
      applied: { keyOffset: shift.keyOffset, tempo: shift.tempo },
    },
  };
};

const applyAck = (
  state: PartyState,
  frame: Extract<ServerToMicParty, { type: 'ack' }>,
  at: number,
): PartyState => {
  const request = state.pending.find((each) => each.reqId === frame.reqId);
  if (request === undefined) {
    return state;
  }
  const settled = { ...state, pending: state.pending.filter((each) => each !== request) };
  if (!frame.ok) {
    return withFailure(settled, request.kind, frame.code ?? 'invalid');
  }
  return request.kind === 'shift-current' ? applyShift(settled, request, at) : settled;
};

const lyricView = (
  frame: Extract<ServerToMicParty, { type: 'lyric' }>,
  at: number,
): LyricView | null => {
  if (frame.line === undefined) {
    return null;
  }
  return {
    line: frame.line,
    paused: frame.paused,
    receivedAt: at,
    ...(frame.next === undefined ? {} : { next: frame.next }),
    ...(frame.lineMs === undefined ? {} : { lineMs: frame.lineMs }),
    ...(frame.elapsedMs === undefined ? {} : { elapsedMs: frame.elapsedMs }),
  };
};

const calibrationView = (
  frame: Extract<ServerToMicParty, { type: 'calibration' }>,
): CalibrationView => {
  switch (frame.state) {
    case 'started':
      return { state: 'started' };
    case 'done':
      return frame.latencyMs === undefined
        ? { state: 'done' }
        : { state: 'done', latencyMs: frame.latencyMs };
    case 'failed':
      return frame.reason === undefined
        ? { state: 'failed' }
        : { state: 'failed', reason: frame.reason };
  }
  frame.state satisfies never;
  return { state: 'idle' };
};

const noticeBody = (frame: Extract<ServerToMicParty, { type: 'notice' }>): MessageBody => ({
  kind: 'notice',
  code: frame.code,
  ...(frame.title === undefined ? {} : { title: frame.title }),
  ...(isMicSlot(frame.bySlot) ? { bySlot: frame.bySlot } : {}),
});

const applyFrame = (state: PartyState, frame: ServerToMicParty, at: number): PartyState => {
  switch (frame.type) {
    case 'party':
      return applySnapshot(state, frame.party, at);
    case 'ack':
      return applyAck(state, frame, at);
    case 'lyric':
      return { ...state, lyric: lyricView(frame, at) };
    case 'calibration':
      return { ...state, calibration: calibrationView(frame) };
    case 'notice':
      return withMessage(state, noticeBody(frame));
    case 'night-rank':
      return {
        ...state,
        nightRank:
          frame.rank === undefined
            ? { entries: frame.entries }
            : { rank: frame.rank, entries: frame.entries },
      };
  }
  frame satisfies never;
  return state;
};

const applySent = (state: PartyState, request: PendingRequest): PartyState => {
  const pending = { ...state, pending: [...state.pending, request] };
  return request.kind === 'calibrate'
    ? { ...pending, calibration: { state: 'requested' }, calibrateSentAt: request.sentAt }
    : pending;
};

const applyAckTimeout = (state: PartyState, reqId: number): PartyState => {
  const request = state.pending.find((each) => each.reqId === reqId);
  if (request === undefined) {
    return state;
  }
  const settled = { ...state, pending: state.pending.filter((each) => each !== request) };
  return withFailure(settled, request.kind, 'no-ack');
};

type RequestEvent = Extract<PartyEvent, { type: 'frame' | 'sent' | 'not-sent' | 'ack-timeout' }>;
type LocalEvent = Exclude<PartyEvent, RequestEvent>;

const REQUEST_EVENTS: ReadonlySet<PartyEvent['type']> = new Set([
  'frame',
  'sent',
  'not-sent',
  'ack-timeout',
]);

const isRequestEvent = (event: PartyEvent): event is RequestEvent => REQUEST_EVENTS.has(event.type);

const reduceRequestEvent = (state: PartyState, event: RequestEvent): PartyState => {
  switch (event.type) {
    case 'frame':
      return applyFrame(state, event.frame, event.at);
    case 'sent':
      return applySent(state, event.request);
    case 'not-sent':
      return withFailure(state, event.kind, 'offline');
    case 'ack-timeout':
      return applyAckTimeout(state, event.reqId);
  }
  event satisfies never;
  return state;
};

const reduceLocalEvent = (state: PartyState, event: LocalEvent): PartyState => {
  switch (event.type) {
    case 'fx':
      return { ...state, fx: takeToken(state.fx, FX_RULE, event.at) ?? state.fx };
    case 'mix-draft':
      return { ...state, mixDraft: { ...state.mixDraft, ...event.values } };
    case 'mix-settled':
      return { ...state, mixDraft: {} };
    case 'dismiss':
      return { ...state, messages: state.messages.filter((message) => message.id !== event.id) };
    case 'song-result':
      return { ...state, nightRank: null };
    case 'reset':
      return initialPartyState(event.at);
  }
  event satisfies never;
  return state;
};

/** Party state on the phone: a pure reducer over the §13.4 frames and the phone's own requests. */
export const reduceParty = (state: PartyState, event: PartyEvent): PartyState =>
  isRequestEvent(event) ? reduceRequestEvent(state, event) : reduceLocalEvent(state, event);
