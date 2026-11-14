import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { remoteMics } from '@/bridge/remote-mics';
import { playbackLocationStateSchema } from '@/bridge/schemas';
import { MAX_WORDS_PER_LINE } from '@/features/noraebang/lyric-layout';
import { preparePlayback } from '@/features/playback/mutations/use-prepare-playback-mutation';
import {
  usePlaybackMicState,
  usePlaybackTransportActions,
  usePlaybackTransportState,
} from '@/features/playback/providers';
import { usePlaybackStartupState } from '@/features/playback/providers/playback-startup-context';
import { splitLongSegments } from '@/features/playback/utils/transcript-segments';
import type { MicSlot, StageKind } from '@/features/remote-mic/protocol';
import { useLatestRef } from '@/shared/hooks/use-latest-ref';
import type { Song } from '@/types/Song';
import type { Segment } from '@/types/Transcript';

import { LyricLineSender, type LyricLine } from './lyric-sender';
import { partyTv } from './party-store';

/**
 * The playing song's side of the party channel: it reports the stage
 * (starting, singing, paused, reveal) with the slots it scores, and carries
 * out the phone remote of its singers (pause, resume, stop, key/tempo).
 */

const stageKind = (resultOpen: boolean, started: boolean, paused: boolean): StageKind => {
  if (resultOpen) {
    return 'reveal';
  }
  if (!started) {
    return 'starting';
  }
  return paused ? 'paused' : 'singing';
};

/** Slots of the phones this song scores, in player order. */
function useScoredSlots(): MicSlot[] {
  const { players } = usePlaybackMicState();
  const { devices } = useSyncExternalStore(remoteMics.subscribe, remoteMics.getSnapshot);
  return useMemo(() => {
    const slots: MicSlot[] = [];
    for (const player of players) {
      const slot = devices.find((device) => device.id === player.microphoneId)?.slot;
      if (slot !== undefined && !slots.includes(slot)) {
        slots.push(slot);
      }
    }
    return slots;
  }, [devices, players]);
}

export function usePartyPlaybackStage(song: Song, resultOpen: boolean): void {
  const { paused } = usePlaybackTransportState();
  const { started } = usePlaybackStartupState();
  const singers = useScoredSlots();
  const location = useLocation();
  const state = stageKind(resultOpen, started, paused);
  const singerKey = singers.join(',');

  useEffect(() => {
    const session = playbackLocationStateSchema.safeParse(location.state);
    const queueEntry =
      session.success && session.data.queuePlayback === true
        ? (session.data.playbackId ?? null)
        : null;
    const entryId = partyTv.playingEntry() ?? queueEntry;
    partyTv.reportStage({
      state,
      ...(entryId === null ? {} : { entryId }),
      singers: singerKey === '' ? [] : singerKey.split(',').map(Number),
      title: song.title,
      artist: song.artist,
    });
  }, [location.state, singerKey, song.artist, song.title, state]);
}

type Shift = { keyOffset: number; tempo: number; attempt: number };

/** Renders the new key/tempo with the existing variant path, then restarts the song with the same singers. */
async function restartShifted(
  song: Song,
  locationState: unknown,
  navigate: ReturnType<typeof useNavigate>,
  { keyOffset, tempo, attempt }: Shift,
): Promise<void> {
  const session = playbackLocationStateSchema.parse(locationState);
  const prepared = await preparePlayback({ song, keyOffset, tempo });
  // The restarted song is still the same queue entry.
  partyTv.setPlayingEntry(partyTv.getState().stage.entryId ?? null);
  await navigate('/playback', {
    replace: true,
    state: {
      ...session,
      song: prepared,
      playbackId: `${session.playbackId ?? song.file_hash}-shift-${attempt}`,
    },
  });
}

export function usePartyPlaybackControls(song: Song, resultOpen: boolean): void {
  const { paused } = usePlaybackTransportState();
  const { started } = usePlaybackStartupState();
  const { handlePause, handleContinue, handleExit } = usePlaybackTransportActions();
  const location = useLocation();
  const locationState: unknown = location.state;
  const navigate = useNavigate();
  const shifting = useRef(false);
  const shifts = useRef(0);
  const latest = useLatestRef({
    song,
    resultOpen,
    paused,
    started,
    handlePause,
    handleContinue,
    handleExit,
    locationState,
    navigate,
  });

  useEffect(
    () =>
      partyTv.registerPlayback({
        pause: () => {
          const current = latest.current;
          if (current.started && !current.paused && !current.resultOpen) {
            current.handlePause();
          }
        },
        resume: () => {
          const current = latest.current;
          if (current.paused && !current.resultOpen) {
            current.handleContinue();
          }
        },
        stop: () => {
          if (!latest.current.resultOpen) {
            latest.current.handleExit();
          }
        },
        shift: (slot, keyOffset, tempo) => {
          const current = latest.current;
          if (shifting.current || current.resultOpen) {
            partyTv.notify(slot, 'shift-failed', current.song.title);
            return;
          }
          shifting.current = true;
          shifts.current += 1;
          partyTv.setShifting(true);
          void restartShifted(current.song, current.locationState, current.navigate, {
            keyOffset,
            tempo,
            attempt: shifts.current,
          })
            .catch(() => partyTv.notify(slot, 'shift-failed', current.song.title))
            .finally(() => {
              shifting.current = false;
              partyTv.setShifting(false);
            });
        },
      }),
    [latest],
  );
}

const lyricLines = (segments: readonly Segment[]): LyricLine[] =>
  splitLongSegments([...segments], MAX_WORDS_PER_LINE).map(({ text, start, end }) => ({
    text,
    start,
    end,
  }));

/** Sends the singers' phones the line being sung, from the same lines the noraebang bar shows. */
export function usePartyLyrics(segments: readonly Segment[]): void {
  const { paused, isPlaying } = usePlaybackTransportState();
  const { subscribe, getCurrentTime } = usePlaybackTransportActions();
  const lines = useMemo(() => lyricLines(segments), [segments]);
  const halted = paused || !isPlaying;
  const haltedRef = useLatestRef(halted);
  const senderRef = useRef<LyricLineSender | null>(null);

  useEffect(() => {
    const sender = new LyricLineSender(
      {
        send: (frame) => {
          if (partyTv.getState().stage.singers.length > 0) {
            partyTv.sendLyric(frame);
          }
        },
        now: () => performance.now(),
        later: (fn, ms) => {
          const timer = setTimeout(fn, ms);
          return () => clearTimeout(timer);
        },
      },
      lines,
    );
    senderRef.current = sender;
    sender.update(getCurrentTime(), haltedRef.current);
    const unsubscribe = subscribe((time) => sender.update(time, haltedRef.current));
    return () => {
      unsubscribe();
      sender.stop();
      senderRef.current = null;
    };
  }, [getCurrentTime, haltedRef, lines, subscribe]);

  useEffect(() => {
    senderRef.current?.update(getCurrentTime(), halted);
  }, [getCurrentTime, halted]);
}
