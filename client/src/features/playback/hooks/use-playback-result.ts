import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import successSoundUrl from '@/assets/sounds/success.mp3';
import type { PlaybackPlayer } from '@/bridge/playback-session';
import { addScore } from '@/bridge/profile';
import {
  usePlaybackQueueQuery,
  useStartNextPlaybackQueueSong,
} from '@/features/playback-queue/use-playback-queue';
import {
  usePlaybackMicState,
  usePlaybackTranscriptActions,
  usePlaybackTranscriptState,
  usePlaybackTransportActions,
  usePlaybackTransportState,
} from '@/features/playback/providers';
import { useProfiles } from '@/features/profiles/queries/use-profiles';
import { t } from '@/i18n';
import { useLatestRef } from '@/shared/hooks/use-latest-ref';
import { defaultPlayerColor, type PlayerColor } from '@/shared/player-colors';
import { PROFILES } from '@/shared/query-keys';
import type { ScoreRecord } from '@/types/ScoreRecord';
import type { Song } from '@/types/Song';

export type PlaybackPlayerResult = {
  id: string;
  profile: string | null;
  color: PlayerColor;
  score: number;
  /** Share of the singable time with a detected voice, 0-1. */
  voicedRatio: number;
};

type FinalResultsInput = {
  multiplayer: boolean;
  players: ReturnType<typeof usePlaybackMicState>['players'];
  activeProfile: string | null;
  soloScore: number;
  soloVoicedRatio: number;
};

function buildFinalResults(input: FinalResultsInput): PlaybackPlayerResult[] {
  if (!input.multiplayer) {
    return [
      {
        id: 'solo',
        profile: input.activeProfile,
        color: defaultPlayerColor(0),
        score: input.soloScore,
        voicedRatio: input.soloVoicedRatio,
      },
    ];
  }
  return input.players.map((player) => ({
    id: player.id,
    profile: player.profile,
    color: player.color,
    score: player.rawScore,
    voicedRatio: player.voicedRatio,
  }));
}

function finishReady(
  isFinished: boolean,
  skipOutroPending: boolean,
  profilesLoading: boolean,
  alreadyHandled: boolean,
): boolean {
  return (isFinished || skipOutroPending) && !profilesLoading && !alreadyHandled;
}

export type PlaybackResult = {
  open: boolean;
  results: PlaybackPlayerResult[];
  scores: ScoreRecord[];
  nextPending: boolean;
  onBack: () => void;
  onNext?: (players?: readonly PlaybackPlayer[]) => void;
};

export type PlaybackResultOptions = {
  /** Show results even for a solo song nobody sang. */
  alwaysShowResult?: boolean;
  /** Play the built-in success sound when results open. */
  playSuccessSound?: boolean;
};

export function usePlaybackResult(
  song: Song,
  queuePlayback: boolean,
  players: readonly PlaybackPlayer[],
  { alwaysShowResult = false, playSuccessSound = true }: PlaybackResultOptions = {},
): PlaybackResult {
  const fileHash = song.file_hash;
  const queryClient = useQueryClient();
  const { data: profileData, isLoading: profilesLoading } = useProfiles();
  const { data: entries = [] } = usePlaybackQueueQuery();
  const { isPreparing, playNext } = useStartNextPlaybackQueueSong(entries);

  const { isFinished } = usePlaybackTransportState();
  const { handleExit } = usePlaybackTransportActions();
  const { rawScore, voicedRatio, players: micPlayers, multiplayer } = usePlaybackMicState();
  const { skipOutroPending } = usePlaybackTranscriptState();
  const { clearSkipOutroPending } = usePlaybackTranscriptActions();

  const [showResult, setShowResult] = useState(false);
  const [results, setResults] = useState<PlaybackPlayerResult[]>([]);
  const micPlayersRef = useLatestRef(micPlayers);
  const scoreRef = useLatestRef(rawScore);
  const voicedRatioRef = useLatestRef(voicedRatio);
  const finishHandledRef = useRef(false);

  useEffect(() => {
    if (!finishReady(isFinished, skipOutroPending, profilesLoading, finishHandledRef.current)) {
      return;
    }

    finishHandledRef.current = true;
    clearSkipOutroPending();

    const finalResults = buildFinalResults({
      multiplayer,
      players: micPlayersRef.current,
      activeProfile: profileData?.active ?? null,
      soloScore: scoreRef.current,
      soloVoicedRatio: voicedRatioRef.current,
    });
    const shouldShowResult =
      alwaysShowResult ||
      multiplayer ||
      queuePlayback ||
      finalResults.some((result) => result.score > 0);

    if (!shouldShowResult) {
      handleExit();
      return;
    }

    void (async () => {
      try {
        await Promise.all(
          finalResults.flatMap((result) =>
            result.profile === null ? [] : [addScore(fileHash, result.score, result.profile)],
          ),
        );
        if (finalResults.some((result) => result.profile !== null)) {
          await queryClient.invalidateQueries({ queryKey: PROFILES });
        }
      } catch (error) {
        toast.error(
          t('playback.usePlaybackResult.couldNotSaveScore', {
            value1: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      setResults(finalResults.toSorted((left, right) => right.score - left.score));
      setShowResult(true);
    })();
  }, [
    alwaysShowResult,
    clearSkipOutroPending,
    fileHash,
    handleExit,
    isFinished,
    micPlayersRef,
    multiplayer,
    profileData?.active,
    profilesLoading,
    queryClient,
    queuePlayback,
    scoreRef,
    skipOutroPending,
    voicedRatioRef,
  ]);

  useEffect(() => {
    if (!showResult || !playSuccessSound) {
      return undefined;
    }

    const audioElement = new Audio(successSoundUrl);
    void audioElement.play().catch(() => {});

    return () => {
      audioElement.pause();
      audioElement.src = '';
    };
  }, [playSuccessSound, showResult]);

  const onBack = useCallback(() => {
    setShowResult(false);
    handleExit();
  }, [handleExit]);
  const onNext = useCallback(
    (nextPlayers: readonly PlaybackPlayer[] = players) => playNext([...nextPlayers]),
    [playNext, players],
  );
  const hasNext = queuePlayback && entries.length > 0;

  return {
    open: showResult,
    results,
    scores: profileData?.scores ?? [],
    nextPending: isPreparing,
    onBack,
    onNext: hasNext ? onNext : undefined,
  };
}
