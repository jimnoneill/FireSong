import type { PartyController } from './party-controller';
import type { PhoneMicSession } from './session';
import type { SongBook } from './song-book';

/** Everything the `/m` page drives: the mic, the party channel and the song book. */
export type PhoneMicApp = {
  session: PhoneMicSession;
  party: PartyController;
  songBook: SongBook;
  /** Current input level on a 0..1 scale, for the meter. */
  readLevel: () => number;
  /** A short buzz where the phone supports it (not on iOS). */
  vibrate: (ms: number) => void;
};
