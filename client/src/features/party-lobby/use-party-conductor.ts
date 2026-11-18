import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { flight } from '@/bridge/flight';
import { remoteMics } from '@/bridge/remote-mics';
import {
  useMovePlaybackQueueEntry,
  usePlaybackQueueQuery,
  useRemovePlaybackQueueEntry,
  useStartNextPlaybackQueueSong,
} from '@/features/playback-queue/use-playback-queue';
import type { MicSlot } from '@/features/remote-mic/protocol';
import { setPartySoloMic } from '@/features/remote-mic/solo-mic';
import { useLatestRef } from '@/shared/hooks/use-latest-ref';

import {
  LobbyConductor,
  type ConductorEntry,
  type ConductorPorts,
  type LobbyStatus,
} from './conductor';
import { partyTv, usePartyTv } from './party-store';

const TICK_MS = 250;

const statusKey = (status: LobbyStatus): string => JSON.stringify(status);

export type PartyConductor = {
  status: LobbyStatus;
  entries: readonly ConductorEntry[];
  startNow: () => boolean;
};

/**
 * Runs the lobby conductor against the upstream queue, the party snapshot
 * and the roster. Songs start through the same queue start as everywhere
 * else (`useStartNextPlaybackQueueSong`), with the item's phones as players.
 */
export function usePartyConductor({
  autoStart,
  idle,
}: {
  autoStart: boolean;
  idle: boolean;
}): PartyConductor {
  const { data: queue = [] } = usePlaybackQueueQuery();
  const { playNext, isPreparing } = useStartNextPlaybackQueueSong(queue);
  const { mutate: move } = useMovePlaybackQueueEntry();
  const { mutate: remove } = useRemovePlaybackQueueEntry();
  const { snapshot } = usePartyTv();
  const { devices } = useSyncExternalStore(remoteMics.subscribe, remoteMics.getSnapshot);
  const actions = useLatestRef({ playNext, move, remove });
  const [status, setStatus] = useState<LobbyStatus>({ kind: 'empty' });
  const [conductor] = useState(() => {
    const ports: ConductorPorts = {
      stage: (report) => partyTv.reportStage(report),
      start: ({ entryId, players, soloMicrophoneId }) => {
        flight('party-start', { entryId, singers: players.length });
        setPartySoloMic(soloMicrophoneId);
        partyTv.setPlayingEntry(entryId);
        actions.current.playNext(players);
      },
      move: (id, targetIndex) => actions.current.move({ id, targetIndex }),
      remove: (id) => {
        flight('party-start-failed', { entryId: id });
        setPartySoloMic(null);
        partyTv.setPlayingEntry(null);
        actions.current.remove(id);
      },
      notify: (slot, code, title) => {
        flight('party-notice', { slot, code });
        partyTv.notify(slot, code, title);
      },
    };
    return new LobbyConductor(ports, () => Date.now());
  });
  const shown = useRef(statusKey(status));

  const entries = useMemo(
    () =>
      queue.map((entry) => ({ id: entry.id, title: entry.song.title, artist: entry.song.artist })),
    [queue],
  );
  const mics = useMemo(
    () => new Map<MicSlot, string>(devices.map((device) => [device.slot, device.micId])),
    [devices],
  );

  // Back from a song: the next start names its own singers.
  useEffect(() => {
    if (idle) {
      setPartySoloMic(null);
      partyTv.setPlayingEntry(null);
    }
  }, [idle]);

  useEffect(() => {
    const publish = () => {
      const next = conductor.status();
      const key = statusKey(next);
      if (key !== shown.current) {
        shown.current = key;
        setStatus(next);
      }
    };
    conductor.update({
      autoStart,
      idle,
      preparing: isPreparing,
      entries,
      items: snapshot?.queue ?? [],
      singers: snapshot?.singers ?? [],
      mics,
    });
    publish();
    if (!idle) {
      return undefined;
    }
    const timer = setInterval(() => {
      conductor.tick();
      publish();
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [autoStart, conductor, entries, idle, isPreparing, mics, snapshot]);

  const startNow = useCallback(() => conductor.startNow(), [conductor]);

  return { status, entries, startNow };
}
