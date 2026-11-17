import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router';

import { fireSongLaunch } from '@/bridge/firesong-launch';
import { loadMicLinks, remoteMics } from '@/bridge/remote-mics';
import { isTauri } from '@/bridge/runtime';
import { useNoraebangSettings } from '@/features/noraebang/settings';
import { useAddPlaybackQueueEntry } from '@/features/playback-queue/use-playback-queue';
import { linkParty } from '@/features/remote-mic/party-link';
import { useShouldRunSetup } from '@/features/setup/hooks/use-should-run-setup';

import { lobbyModel } from '../lobby-model';
import { partyTv, usePartyTv } from '../party-store';
import { usePartyConductor } from '../use-party-conductor';
import { PartyLobby } from './party-lobby';
import { PartyOverlays } from './party-overlays';
import { TvSongBook } from './tv-song-book';

const MIC_LINKS = ['firesong', 'mic-links'];
const MIC_LINKS_REFRESH_MS = 60_000;

function PartyTv() {
  const { pathname } = useLocation();
  const noraebang = useNoraebangSettings().enabled;
  const { shouldRunSetup } = useShouldRunSetup();
  const idle = pathname === '/' && !shouldRunSetup;
  const lobbyOn = noraebang && idle;
  const { snapshot, tuning, songs } = usePartyTv();
  // The song book closes with the next song that opens.
  const [pickingAt, setPickingAt] = useState<number | null>(null);
  const picking = lobbyOn && pickingAt === songs;
  const { mutate: addToQueue } = useAddPlaybackQueueEntry();
  // The countdown holds while a phone is tuned, so no song starts over the beep,
  // and while the song book is open, so none starts under it.
  const { status, entries, startNow } = usePartyConductor({
    autoStart: lobbyOn && !picking && tuning === null,
    idle,
  });
  const { devices, connected } = useSyncExternalStore(remoteMics.subscribe, remoteMics.getSnapshot);
  const links = useQuery({
    queryKey: MIC_LINKS,
    queryFn: loadMicLinks,
    enabled: lobbyOn && !picking,
    refetchInterval: MIC_LINKS_REFRESH_MS,
  });
  const model = useMemo(
    () => lobbyModel({ snapshot, entries, links: links.data?.slots ?? [], devices }),
    [devices, entries, links.data, snapshot],
  );

  useEffect(() => linkParty(remoteMics), []);

  useEffect(
    () =>
      partyTv.registerLobby({
        startNow: () => {
          startNow();
        },
      }),
    [startNow],
  );

  return (
    <>
      {picking && (
        <TvSongBook
          onPick={(song) => {
            addToQueue({ song, tempo: song.tempo, keyOffset: song.key_offset });
            setPickingAt(null);
          }}
          onClose={() => setPickingAt(null)}
        />
      )}
      {lobbyOn && !picking && (
        <PartyLobby
          model={model}
          status={status}
          connected={connected}
          linksError={links.isError}
          onStartNow={() => {
            startNow();
          }}
          onPickSong={() => setPickingAt(songs)}
          onClearBest={() => {
            partyTv.resetScores();
          }}
        />
      )}
      <PartyOverlays />
    </>
  );
}

/**
 * The TV's party layer (`?tv=1`): the lobby between songs in noraebang mode,
 * the conductor that starts queued songs with their singers, and the party
 * notices. Nothing elsewhere: an operator's browser and the desktop app keep
 * the library as it is.
 */
export function PartyTvHost() {
  return fireSongLaunch().tv && !isTauri ? <PartyTv /> : null;
}
