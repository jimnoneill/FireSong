import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router';

import { fireSongLaunch } from '@/bridge/firesong-launch';
import { loadMicLinks, remoteMics } from '@/bridge/remote-mics';
import { isTauri } from '@/bridge/runtime';
import { useNoraebangSettings } from '@/features/noraebang/settings';
import { linkParty } from '@/features/remote-mic/party-link';
import { useShouldRunSetup } from '@/features/setup/hooks/use-should-run-setup';

import { lobbyModel } from '../lobby-model';
import { partyTv, usePartyTv } from '../party-store';
import { useLobbyDismissal } from '../use-lobby-dismissal';
import { usePartyConductor } from '../use-party-conductor';
import { PartyLobby } from './party-lobby';
import { PartyOverlays } from './party-overlays';

const MIC_LINKS = ['firesong', 'mic-links'];
const MIC_LINKS_REFRESH_MS = 60_000;

function PartyTv() {
  const { pathname } = useLocation();
  const noraebang = useNoraebangSettings().enabled;
  const { shouldRunSetup } = useShouldRunSetup();
  const { dismissed, dismiss } = useLobbyDismissal();
  const idle = pathname === '/' && !shouldRunSetup;
  const lobbyOn = noraebang && idle && !dismissed;
  const { status, entries, startNow } = usePartyConductor({ autoStart: lobbyOn, idle });
  const { snapshot } = usePartyTv();
  const { devices, connected } = useSyncExternalStore(remoteMics.subscribe, remoteMics.getSnapshot);
  const links = useQuery({
    queryKey: MIC_LINKS,
    queryFn: loadMicLinks,
    enabled: lobbyOn,
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
      {lobbyOn && (
        <PartyLobby
          model={model}
          status={status}
          connected={connected}
          linksError={links.isError}
          onStartNow={() => {
            startNow();
          }}
          onClearBest={() => {
            partyTv.resetScores();
          }}
          onDismiss={dismiss}
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
