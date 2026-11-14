import {
  DEFAULT_ECHO_PCT,
  DEFAULT_VOLUME_PCT,
  isMicSlot,
  MAX_PREPARING_PER_SLOT,
  MAX_RESERVATIONS_PER_SLOT,
  MAX_SHIFTS_PER_SONG,
  MAX_SING_NEXT_PER_SLOT,
  SHIFT_CURRENT_COOLDOWN_SECS,
  type MicSlot,
  type PartyItem,
  type PartySinger,
  type PartySnapshot,
  type PartyStage,
  type PrepState,
} from '@/features/remote-mic/protocol';

import { CALIBRATE_COOLDOWN_MS, type PartyState, type ShiftValues } from './party-state';

const SINGING_STAGES: ReadonlySet<PartyStage['state']> = new Set(['starting', 'singing', 'paused']);

export const isReady = (prep: PrepState): boolean => prep.state === 'ready';

export const singsIn = (item: { singers: readonly number[] }, slot: MicSlot | null): boolean =>
  slot !== null && item.singers.includes(slot);

/** The owner is the first singer; the others are partners. */
export const ownsItem = (item: PartyItem, slot: MicSlot | null): boolean =>
  slot !== null && item.singers[0] === slot;

export const mySinger = (
  snapshot: PartySnapshot | null,
  slot: MicSlot | null,
): PartySinger | null => snapshot?.singers.find((singer) => singer.slot === slot) ?? null;

export const singerFor = (snapshot: PartySnapshot | null, slot: number): PartySinger | null =>
  snapshot?.singers.find((singer) => singer.slot === slot) ?? null;

/** Slots of the other occupied slots, for the duet picker. */
export const partnerChoices = (
  snapshot: PartySnapshot | null,
  slot: MicSlot | null,
): readonly MicSlot[] =>
  (snapshot?.singers ?? [])
    .map((singer) => singer.slot)
    .filter((each): each is MicSlot => isMicSlot(each) && each !== slot);

export const myItems = (snapshot: PartySnapshot | null, slot: MicSlot | null): PartyItem[] =>
  (snapshot?.queue ?? []).filter((item) => singsIn(item, slot));

/** The item the TV starts next: the first ready one (preparing items never hold it up). */
export const firstReadyItem = (snapshot: PartySnapshot | null): PartyItem | null =>
  snapshot?.queue.find((item) => isReady(item.prep) && item.entryId !== undefined) ?? null;

/** This phone sings the song on stage, so it holds the remote. */
export const singsCurrent = (snapshot: PartySnapshot | null, slot: MicSlot | null): boolean =>
  snapshot !== null && SINGING_STAGES.has(snapshot.stage.state) && singsIn(snapshot.stage, slot);

/** In the lobby, this phone sings the next song, so it may skip the countdown. */
export const canStartNow = (snapshot: PartySnapshot | null, slot: MicSlot | null): boolean => {
  const next = firstReadyItem(snapshot);
  return snapshot?.stage.state === 'lobby' && next !== null && singsIn(next, slot);
};

export type ReservationLimits = {
  owned: number;
  preparing: number;
  singNext: number;
  canReserve: boolean;
  canPrepare: boolean;
  canSingNext: boolean;
};

export const reservationLimits = (
  snapshot: PartySnapshot | null,
  slot: MicSlot | null,
): ReservationLimits => {
  const owned = (snapshot?.queue ?? []).filter((item) => ownsItem(item, slot));
  const preparing = owned.filter((item) => !isReady(item.prep)).length;
  const singNext = owned.filter((item) => item.singNext).length;
  return {
    owned: owned.length,
    preparing,
    singNext,
    canReserve: owned.length < MAX_RESERVATIONS_PER_SLOT,
    canPrepare: preparing < MAX_PREPARING_PER_SLOT,
    canSingNext: singNext < MAX_SING_NEXT_PER_SLOT,
  };
};

/** Identifies the song on stage for the shift limits: its reservation, else its title. */
export const stageSongKey = (stage: PartyStage): string =>
  stage.reservationId ?? `title:${stage.title ?? ''}`;

export type CurrentSong = {
  title?: string;
  artist?: string;
  /** Key and tempo can be changed; `false` when the phone never saw the item. */
  shiftable: boolean;
  settings: ShiftValues;
};

const stageItem = (state: PartyState, stage: PartyStage): PartyItem | undefined =>
  stage.reservationId === undefined
    ? undefined
    : state.recentItems.find((each) => each.reservationId === stage.reservationId);

const stageSettings = (state: PartyState, stage: PartyStage, item?: PartyItem): ShiftValues => {
  if (state.shift?.songKey === stageSongKey(stage)) {
    return state.shift.applied;
  }
  return { keyOffset: item?.keyOffset ?? 0, tempo: item?.tempo ?? 1 };
};

export const currentSong = (state: PartyState): CurrentSong | null => {
  const stage = state.snapshot?.stage;
  if (stage === undefined || !SINGING_STAGES.has(stage.state)) {
    return null;
  }
  const item = stageItem(state, stage);
  return {
    ...(stage.title === undefined ? {} : { title: stage.title }),
    ...(stage.artist === undefined ? {} : { artist: stage.artist }),
    shiftable: item?.shiftable === true,
    settings: stageSettings(state, stage, item),
  };
};

export type ShiftAllowance =
  | { kind: 'ok' }
  | { kind: 'cooldown'; until: number }
  | { kind: 'used-up' };

export const shiftAllowance = (state: PartyState, now: number): ShiftAllowance => {
  const stage = state.snapshot?.stage;
  const shift = state.shift;
  if (stage === undefined || shift?.songKey !== stageSongKey(stage)) {
    return { kind: 'ok' };
  }
  if (shift.count >= MAX_SHIFTS_PER_SONG) {
    return { kind: 'used-up' };
  }
  const until = shift.lastAt + SHIFT_CURRENT_COOLDOWN_SECS * 1_000;
  return now < until ? { kind: 'cooldown', until } : { kind: 'ok' };
};

/** When "Tune my mic" may be asked again, or `null` when it may now. */
export const calibrateCooldownUntil = (state: PartyState, now: number): number | null => {
  if (state.calibrateSentAt === null) {
    return null;
  }
  const until = state.calibrateSentAt + CALIBRATE_COOLDOWN_MS;
  return now < until ? until : null;
};

export type MixSettings = { volumePct: number; echoPct: number };

export const mixSettings = (state: PartyState, slot: MicSlot | null): MixSettings => {
  const singer = mySinger(state.snapshot, slot);
  return {
    volumePct: state.mixDraft.volumePct ?? singer?.volumePct ?? DEFAULT_VOLUME_PCT,
    echoPct: state.mixDraft.echoPct ?? singer?.echoPct ?? DEFAULT_ECHO_PCT,
  };
};

export const isPending = (
  state: PartyState,
  kind: PartyState['pending'][number]['kind'],
): boolean => state.pending.some((request) => request.kind === kind);

/** Seconds left of the lobby countdown at `now`, counted on from the snapshot's arrival. */
export const countdownLeft = (state: PartyState, now: number): number | null => {
  const secs =
    state.snapshot?.stage.state === 'lobby' ? state.snapshot.stage.countdownSecs : undefined;
  if (secs === undefined) {
    return null;
  }
  return Math.max(0, secs - Math.floor(Math.max(0, now - state.snapshotAt) / 1_000));
};
