import { useEffect, useMemo, useState } from 'react';

import type { PlaybackPlayer } from '@/bridge/playback-session';
import {
  ResultActions,
  type ResultActionsProps,
} from '@/features/playback/components/dialogs/result';
import type { PlaybackPlayerResult } from '@/features/playback/hooks/use-playback-result';
import { playerDisplayName } from '@/features/playback/utils/player-display-name';
import type { Song } from '@/types/Song';

import { useRevealSounds } from '../hooks';
import { buildRevealEntries } from '../reveal-entries';
import { useNoraebangSettings } from '../settings';
import { phoneMicSlot, publishSongResult } from '../song-result';
import { NoraebangScoreReveal } from './noraebang-score-reveal';

type Props = Omit<ResultActionsProps, 'multiplayer'> & {
  results: PlaybackPlayerResult[];
  song: Song;
  /** Multiplayer setup order, for the reveal order of local mics. */
  players: readonly PlaybackPlayer[];
  /** The solo singer's microphone. */
  soloMicrophoneId: string | null;
};

function NoraebangResultScreen({
  results,
  song,
  players,
  soloMicrophoneId,
  ...actions
}: Omit<Props, 'open'>) {
  const settings = useNoraebangSettings();
  const sounds = useRevealSounds();
  const [revealed, setRevealed] = useState(false);

  const entries = useMemo(
    () =>
      buildRevealEntries({
        songHash: song.file_hash,
        results,
        players:
          players.length > 0
            ? players
            : results.map((result) => ({ id: result.id, microphoneId: soloMicrophoneId })),
        nameFor: (result) => playerDisplayName(result, results),
        slotFor: phoneMicSlot,
      }),
    [players, results, soloMicrophoneId, song.file_hash],
  );

  useEffect(() => {
    publishSongResult(
      song.title,
      entries.map(({ microphoneId, score, rank }) => ({ microphoneId, score, rank })),
    );
  }, [entries, song.title]);

  return (
    <NoraebangScoreReveal
      title={song.title}
      artist={song.artist}
      entries={entries}
      sounds={sounds}
      koreanCaptions={settings.koreanCaptions}
      onRevealed={() => setRevealed(true)}
    >
      <ResultActions open={revealed} multiplayer={results.length > 1} {...actions} />
    </NoraebangScoreReveal>
  );
}

/**
 * Noraebang results: the 0-100 score reveal, then the usual result actions.
 * Profiles keep the raw score; only the screen and the phones see 0-100.
 */
export function NoraebangResult({ open, ...props }: Props) {
  return open ? <NoraebangResultScreen {...props} /> : null;
}
