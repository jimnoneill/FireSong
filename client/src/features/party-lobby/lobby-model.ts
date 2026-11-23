import type { RemoteMicDevice } from '@/bridge/remote-mics';
import {
  isMicSlot,
  MIC_SLOTS,
  slotColor,
  type MicLink,
  type MicSlot,
  type NightScore,
  type PartySnapshot,
  type PrepState,
} from '@/features/remote-mic/protocol';
import type { PlayerColor } from '@/shared/player-colors';

import type { ConductorEntry } from './conductor';

/**
 * What the party lobby shows, derived from the party snapshot, the upstream
 * queue (when no snapshot has arrived, for example on an older server), the
 * TV roster and the join links.
 */

export const UP_NEXT_COUNT = 5;
export const BEST_COUNT = 5;

export type LobbySinger = {
  slot: MicSlot;
  color: PlayerColor;
  name: string | null;
  reconnecting: boolean;
};

export type LobbySlot = {
  slot: MicSlot;
  color: PlayerColor;
  link: MicLink | null;
  singer: LobbySinger | null;
};

export type LobbyItem = {
  key: string;
  title: string;
  artist: string;
  singers: LobbySinger[];
  prep: PrepState;
};

export type LobbyModel = {
  slots: LobbySlot[];
  upNext: LobbyItem[];
  /** Queued songs beyond `upNext`. */
  more: number;
  best: NightScore[];
  queued: number;
  /** Phones in line for a free mic. */
  waiting: number;
};

export type LobbyModelInput = {
  snapshot: PartySnapshot | null;
  entries: readonly ConductorEntry[];
  links: readonly MicLink[];
  devices: readonly RemoteMicDevice[];
};

const READY: PrepState = { state: 'ready' };

const singersOf = (snapshot: PartySnapshot | null, devices: readonly RemoteMicDevice[]) => {
  if (snapshot === null) {
    return devices.map((device) => ({
      slot: device.slot,
      color: slotColor(device.slot),
      name: null,
      reconnecting: device.reconnecting,
    }));
  }
  return snapshot.singers.flatMap((singer) =>
    isMicSlot(singer.slot)
      ? [
          {
            slot: singer.slot,
            color: singer.color,
            name: singer.name ?? null,
            reconnecting: singer.state === 'reserved',
          },
        ]
      : [],
  );
};

export const lobbyModel = ({ snapshot, entries, links, devices }: LobbyModelInput): LobbyModel => {
  const singers: LobbySinger[] = singersOf(snapshot, devices);
  const singer = (slot: number) => singers.find((candidate) => candidate.slot === slot) ?? null;
  const slots = MIC_SLOTS.map((slot) => ({
    slot,
    color: slotColor(slot),
    link: links.find((link) => link.slot === slot) ?? null,
    singer: singer(slot),
  }));
  const upNext: LobbyItem[] =
    snapshot === null
      ? entries.slice(0, UP_NEXT_COUNT).map((entry) => ({
          key: entry.id,
          title: entry.title,
          artist: entry.artist,
          singers: [],
          prep: READY,
        }))
      : snapshot.queue.slice(0, UP_NEXT_COUNT).map((item) => ({
          key: item.reservationId,
          title: item.title,
          artist: item.artist,
          singers: item.singers.flatMap((slot) => {
            const found = singer(slot);
            return found === null ? [] : [found];
          }),
          prep: item.prep,
        }));
  const queued = snapshot === null ? entries.length : snapshot.queueTotal;
  return {
    slots,
    upNext,
    more: Math.max(0, queued - upNext.length),
    best: (snapshot?.scores ?? []).slice(0, BEST_COUNT),
    queued,
    waiting: snapshot?.waiting ?? 0,
  };
};
