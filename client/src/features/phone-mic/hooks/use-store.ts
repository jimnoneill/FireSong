import { useSyncExternalStore } from 'react';

/** A store outside React: the phone session, the party controller or the song book. */
export type ExternalStore<T> = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => T;
};

export const useStore = <T>(store: ExternalStore<T>): T =>
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
