/**
 * `song-result` from the TV: when the score reveal starts, each phone-mic
 * singer gets their own noraebang score over `/rtc` (PROTOCOL.md §5.3).
 *
 * The TV's `/rtc` socket owns the connection and the roster, so it registers
 * itself here as the sink; until it does, publishing is a no-op.
 */

import {
  isMicSlot,
  MAX_TITLE_CHARS,
  SLOT_COUNT,
  type MicSlot,
  type SlotResult,
  type TvToServer,
} from '@/features/remote-mic/protocol';

import type { NoraebangScore } from './score';

export type SongResultEntry = {
  /** The player's microphone device id (`remote:<micId>` for phone mics). */
  microphoneId: string | null;
  score: NoraebangScore;
  /** 1-based rank among this song's singers. */
  rank: number;
};

export type SongResultSink = {
  send: (frame: TvToServer) => void;
  /** The slot a phone-mic device id is in now, or `null` (local mic, unknown, empty). */
  slotForMicrophone: (microphoneId: string) => MicSlot | null;
};

export function buildSongResultFrame(
  title: string,
  entries: readonly SongResultEntry[],
  slotForMicrophone: SongResultSink['slotForMicrophone'],
): TvToServer | null {
  const seen = new Set<MicSlot>();
  const results: SlotResult[] = [];
  for (const entry of entries) {
    const slot = entry.microphoneId === null ? null : slotForMicrophone(entry.microphoneId);
    if (slot === null || !isMicSlot(slot) || seen.has(slot) || results.length >= SLOT_COUNT) {
      continue;
    }
    seen.add(slot);
    results.push({
      slot,
      displayScore: entry.score.displayScore,
      rawScore: entry.score.rawScore,
      tier: entry.score.tier,
      rank: entry.rank,
    });
  }
  if (results.length === 0) {
    return null;
  }

  // The server counts Unicode code points, as `Array.from` does.
  const trimmed = Array.from(title.trim()).slice(0, MAX_TITLE_CHARS).join('');
  return trimmed === ''
    ? { type: 'song-result', results }
    : { type: 'song-result', title: trimmed, results };
}

let sink: SongResultSink | null = null;

/** Called by the TV `/rtc` socket once it is up. Returns the unregister function. */
export function registerSongResultSink(next: SongResultSink): () => void {
  sink = next;
  return () => {
    if (sink === next) {
      sink = null;
    }
  };
}

/** Sends the result to the phones; `false` when there is no sink or no phone singer. */
export function publishSongResult(title: string, entries: readonly SongResultEntry[]): boolean {
  const current = sink;
  if (current === null) {
    return false;
  }
  const frame = buildSongResultFrame(title, entries, current.slotForMicrophone);
  if (frame === null) {
    return false;
  }
  current.send(frame);
  return true;
}
