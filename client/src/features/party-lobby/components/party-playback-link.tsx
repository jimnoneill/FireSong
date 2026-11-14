import { fireSongLaunch } from '@/bridge/firesong-launch';
import type { Song } from '@/types/Song';
import type { Segment } from '@/types/Transcript';

import {
  usePartyLyrics,
  usePartyPlaybackControls,
  usePartyPlaybackStage,
} from '../use-party-playback';

type PlaybackLinkProps = { song: Song; resultOpen: boolean };

function PlaybackLink({ song, resultOpen }: PlaybackLinkProps) {
  usePartyPlaybackStage(song, resultOpen);
  usePartyPlaybackControls(song, resultOpen);

  return null;
}

/** On the TV, ties the playing song to the party: stage reports and the singers' phone remote. */
export function PartyPlaybackLink(props: PlaybackLinkProps) {
  return fireSongLaunch().tv ? <PlaybackLink {...props} /> : null;
}

function LyricLink({ segments }: { segments: readonly Segment[] }) {
  usePartyLyrics(segments);

  return null;
}

/** On the TV, sends the singers' phones the line being sung. */
export function PartyLyricLink({ segments }: { segments: readonly Segment[] }) {
  return fireSongLaunch().tv ? <LyricLink segments={segments} /> : null;
}
