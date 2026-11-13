import type { ComponentProps } from 'react';

import { Background } from '@/features/playback/components/background';
import { ResultDialog } from '@/features/playback/components/dialogs/result';
import { LyricsDisplay } from '@/features/playback/components/lyrics-display';

import { NoraebangBackground } from './noraebang-background';
import { NoraebangLyrics } from './noraebang-lyrics';
import { NoraebangResult } from './noraebang-result';

/** Classic background, or the noraebang clip pool. */
export function ModeBackground({ noraebang }: { noraebang: boolean }) {
  return noraebang ? <NoraebangBackground /> : <Background />;
}

type ModeLyricsProps = ComponentProps<typeof LyricsDisplay> & {
  noraebang: boolean;
  title: string;
  artist: string;
};

/** Classic lyrics, or the noraebang two-line wipe bar. */
export function ModeLyrics({ noraebang, title, artist, ...props }: ModeLyricsProps) {
  if (!noraebang) {
    return <LyricsDisplay {...props} />;
  }
  return (
    <NoraebangLyrics
      segments={props.segments}
      title={title}
      artist={artist}
      scale={props.scale}
      romanizationMode={props.romanizationMode}
    />
  );
}

type ModeResultProps = ComponentProps<typeof ResultDialog> &
  Pick<ComponentProps<typeof NoraebangResult>, 'players' | 'soloMicrophoneId'> & {
    noraebang: boolean;
  };

/** Classic results, or the noraebang score reveal followed by the same actions. */
export function ModeResult({
  noraebang,
  players,
  soloMicrophoneId,
  scores,
  ...props
}: ModeResultProps) {
  return noraebang ? (
    <NoraebangResult {...props} players={players} soloMicrophoneId={soloMicrophoneId} />
  ) : (
    <ResultDialog {...props} scores={scores} />
  );
}
