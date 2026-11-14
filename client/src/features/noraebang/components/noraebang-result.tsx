import { useEffect, useMemo, useState } from 'react';

import { fireSongLaunch } from '@/bridge/firesong-launch';
import type { PlaybackPlayer } from '@/bridge/playback-session';
import { useLobbyReturn } from '@/features/party-lobby/use-lobby-return';
import {
  ResultActions,
  type ResultActionsProps,
} from '@/features/playback/components/dialogs/result';
import type { PlaybackPlayerResult } from '@/features/playback/hooks/use-playback-result';
import { playerDisplayName } from '@/features/playback/utils/player-display-name';
import { tp } from '@/i18n';
import type { Song } from '@/types/Song';

import { useRevealSounds } from '../hooks';
import { buildRevealEntries } from '../reveal-entries';
import { useNoraebangSettings } from '../settings';
import { phoneMicName, phoneMicSlot, publishSongResult } from '../song-result';
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
  // On the TV the party lobby starts the next song with its own singers.
  const party = fireSongLaunch().tv;
  const lobbyIn = useLobbyReturn(party && revealed, actions.onBack);

  const entries = useMemo(
    () =>
      buildRevealEntries({
        songHash: song.file_hash,
        results,
        players:
          players.length > 0
            ? players
            : results.map((result) => ({ id: result.id, microphoneId: soloMicrophoneId })),
        // Phone singers keep the name they joined with; party songs carry no profile.
        nameFor: (result, microphoneId) =>
          (microphoneId === null ? null : phoneMicName(microphoneId)) ??
          playerDisplayName(result, results),
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
      <ResultActions
        open={revealed}
        multiplayer={results.length > 1}
        {...actions}
        {...(party ? { onNext: undefined, autoContinue: false } : {})}
      />
      {lobbyIn !== null && (
        <p className="text-[2.2vh] font-semibold text-white/80">
          {tp('firesong.party.backToLobby', lobbyIn)}
        </p>
      )}
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
