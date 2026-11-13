import { useEffect } from 'react';

import { startRemoteMics } from '@/bridge/remote-mics';

/**
 * Keeps the TV's phone-mic registry alive for the whole app, above the
 * routes, so phones stay connected across menu, playback and song changes.
 */
export function RemoteMicsHost() {
  useEffect(() => startRemoteMics(), []);

  return null;
}
