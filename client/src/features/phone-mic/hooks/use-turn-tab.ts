import { useEffect, useState } from 'react';

import type { PhoneTab } from '@/features/phone-mic/components/tabs';
import type { PartyState } from '@/features/phone-mic/lib/party-state';
import {
  canStartNow,
  firstReadyItem,
  singsCurrent,
  stageSongKey,
} from '@/features/phone-mic/lib/party-view';
import type { MicSlot } from '@/features/remote-mic/protocol';

const TURN_BUZZ_MS = 300;

/** The song this phone sings next (in the lobby countdown) or on stage now, or `null`. */
const myTurn = (party: PartyState, slot: MicSlot | null): string | null => {
  const { snapshot } = party;
  if (snapshot !== null && singsCurrent(snapshot, slot)) {
    return stageSongKey(snapshot.stage);
  }
  return canStartNow(snapshot, slot) ? (firstReadyItem(snapshot)?.reservationId ?? null) : null;
};

/**
 * The tab the guest chose, except that their own song coming up opens Sing
 * (countdown, Start now, the song's remote) and buzzes the phone: a guest
 * browsing the song book or the queue would otherwise miss it.
 */
export function useTurnTab(
  party: PartyState,
  slot: MicSlot | null,
  joined: boolean,
  vibrate: (ms: number) => void,
): [PhoneTab, (tab: PhoneTab) => void] {
  const [chosen, setChosen] = useState<PhoneTab>('sing');
  const turn = joined ? myTurn(party, slot) : null;
  const [seenTurn, setSeenTurn] = useState<string | null>(null);
  if (turn !== seenTurn) {
    setSeenTurn(turn);
    if (turn !== null) {
      setChosen('sing');
    }
  }

  useEffect(() => {
    if (turn !== null) {
      vibrate(TURN_BUZZ_MS);
    }
  }, [turn, vibrate]);

  return [chosen, setChosen];
}
