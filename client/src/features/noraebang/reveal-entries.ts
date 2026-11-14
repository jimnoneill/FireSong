import type { PlayerColor } from '@/shared/player-colors';

import { noraebangScore, rankScores, scoreJitter, type NoraebangScore } from './score';

export type RevealEntry = {
  id: string;
  name: string;
  color: PlayerColor;
  microphoneId: string | null;
  score: NoraebangScore;
  /** 1-based rank among this song's singers. */
  rank: number;
};

export type RevealResult = {
  id: string;
  profile: string | null;
  color: PlayerColor;
  /** Raw 0-1000 score. */
  score: number;
  voicedRatio: number;
};

export type RevealPlayer = {
  id: string;
  microphoneId: string | null;
};

export type RevealEntriesInput = {
  songHash: string;
  results: readonly RevealResult[];
  /** Setup order; results without a player keep their own order after these. */
  players: readonly RevealPlayer[];
  nameFor: (result: RevealResult, microphoneId: string | null) => string;
  /** Phone-mic slot of a microphone, or `null`. */
  slotFor: (microphoneId: string) => number | null;
};

/**
 * Display scores, ranks and reveal order for one song. Phone-mic singers are
 * revealed in slot order, everyone else after them in setup order.
 */
export function buildRevealEntries({
  songHash,
  results,
  players,
  nameFor,
  slotFor,
}: RevealEntriesInput): RevealEntry[] {
  const scores = results.map((result) =>
    noraebangScore({
      rawScore: result.score,
      voicedRatio: result.voicedRatio,
      jitter: scoreJitter(`${songHash}:${result.id}`),
    }),
  );
  const ranks = rankScores(scores);

  const ordered = results.map((result, index) => {
    const playerIndex = players.findIndex((player) => player.id === result.id);
    const microphoneId = playerIndex < 0 ? null : players[playerIndex].microphoneId;
    const slot = microphoneId === null ? null : slotFor(microphoneId);
    return {
      entry: {
        id: result.id,
        name: nameFor(result, microphoneId),
        color: result.color,
        microphoneId,
        score: scores[index],
        rank: ranks[index],
      },
      slot: slot ?? Number.POSITIVE_INFINITY,
      order: playerIndex < 0 ? players.length + index : playerIndex,
    };
  });

  return ordered
    .toSorted((left, right) => left.slot - right.slot || left.order - right.order)
    .map(({ entry }) => entry);
}
