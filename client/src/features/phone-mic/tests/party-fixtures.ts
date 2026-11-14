import type { PartyItem, PartySnapshot } from '@/features/remote-mic/protocol';

export const item = (patch: Partial<PartyItem> & { reservationId: string }): PartyItem => ({
  fileHash: `hash-${patch.reservationId}`,
  title: `Song ${patch.reservationId}`,
  artist: 'Artist',
  durationSecs: 200,
  singers: [],
  keyOffset: 0,
  tempo: 1,
  singNext: false,
  shiftable: true,
  prep: { state: 'ready' },
  ...(patch.prep?.state === 'ready' || patch.prep === undefined
    ? { entryId: `e-${patch.reservationId}` }
    : {}),
  ...patch,
});

export const snapshot = (patch: Partial<PartySnapshot> = {}): PartySnapshot => ({
  rev: 1,
  tvConnected: true,
  stage: { state: 'lobby', singers: [] },
  queue: [],
  queueTotal: 0,
  singers: [
    { slot: 1, color: 'rose', name: 'Ann', state: 'connected', volumePct: 100, echoPct: 100 },
    { slot: 2, color: 'fuchsia', name: 'Jim', state: 'connected', volumePct: 80, echoPct: 120 },
  ],
  scores: [],
  ...patch,
});
