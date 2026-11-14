import {
  ABSENT_SINGER_GRACE_SECS,
  isMicSlot,
  LOBBY_COUNTDOWN_SECS,
  remoteMicDeviceId,
  slotColor,
  type MicSlot,
  type NoticeCode,
  type PartyItem,
  type PartySinger,
} from '@/features/remote-mic/protocol';
import type { PlayerColor } from '@/shared/player-colors';

import { LOBBY_STAGE, type StageReport } from './party-store';

/**
 * The party lobby's conductor (PHONE-V2.md feature 7). It watches the first
 * ready item, the head of the upstream playback queue, and starts it after a
 * 15 s countdown when it has no phone singers or its owner is connected. An
 * owner who is reconnecting gets 30 s; then the item moves behind the next
 * ready one, once, and the owner is told. A song that cannot start leaves the
 * queue. Time comes from `now`, so tests drive it with a fake clock.
 */

/** An upstream queue entry: only ready songs are in the queue. */
export type ConductorEntry = { id: string; title: string; artist: string };

export type ConductorInput = {
  /** The lobby is on screen: countdowns and grace periods run. */
  autoStart: boolean;
  /** No song is playing or opening, and the TV is on the library route. */
  idle: boolean;
  /** The upstream start (key/tempo render, queue removal) is running. */
  preparing: boolean;
  entries: readonly ConductorEntry[];
  items: readonly PartyItem[];
  singers: readonly PartySinger[];
  /** `micId` of each slot in the TV roster. */
  mics: ReadonlyMap<MicSlot, string>;
};

export type StartPlayer = {
  id: string;
  profile: string | null;
  microphoneId: string;
  color: PlayerColor;
};

export type StartPlan = {
  entryId: string;
  /** Two or more phone singers; empty for one or none. */
  players: StartPlayer[];
  /** The one phone singer's device, or `null`. */
  soloMicrophoneId: string | null;
};

export type ConductorPorts = {
  stage(report: StageReport): void;
  start(plan: StartPlan): void;
  move(entryId: string, targetIndex: number): void;
  remove(entryId: string): void;
  notify(slot: MicSlot, code: NoticeCode, title: string): void;
};

export type LobbyStatus =
  | { kind: 'empty' }
  | { kind: 'held'; entry: ConductorEntry; singers: MicSlot[] }
  | { kind: 'countdown'; entry: ConductorEntry; singers: MicSlot[]; secondsLeft: number }
  | {
      kind: 'waiting';
      entry: ConductorEntry;
      singers: MicSlot[];
      owner: MicSlot;
      /** Until the item is passed over; `null` when it will not be. */
      secondsLeft: number | null;
    }
  | { kind: 'starting'; entry: ConductorEntry; singers: MicSlot[] };

/** How long an attempt may show no progress before it counts as failed, ms. */
export const START_SETTLE_MS = 1500;
/** An attempt whose start never began counts as failed after this long, ms. */
export const START_NO_PROGRESS_MS = 5000;

const COUNTDOWN_MS = LOBBY_COUNTDOWN_SECS * 1000;
const GRACE_MS = ABSENT_SINGER_GRACE_SECS * 1000;

type Attempt = {
  entry: ConductorEntry;
  singers: MicSlot[];
  at: number;
  sawPreparing: boolean;
  quietSince: number | null;
};

const EMPTY_INPUT: ConductorInput = {
  autoStart: false,
  idle: false,
  preparing: false,
  entries: [],
  items: [],
  singers: [],
  mics: new Map(),
};

export class LobbyConductor {
  private input: ConductorInput = EMPTY_INPUT;
  private focusId: string | null = null;
  private countdownEndsAt: number | null = null;
  private absentSince: number | null = null;
  private readonly passedOver = new Set<string>();
  private attempt: Attempt | null = null;
  private current: LobbyStatus = { kind: 'empty' };

  constructor(
    private readonly ports: ConductorPorts,
    private readonly now: () => number,
  ) {}

  update(input: ConductorInput): void {
    this.input = input;
    this.evaluate();
  }

  tick(): void {
    this.evaluate();
  }

  status(): LobbyStatus {
    return this.current;
  }

  /** OK on the remote, or a phone's `start-now`: start the first ready item at once. */
  startNow(): boolean {
    const entry = this.input.entries.at(0);
    if (!this.input.idle || this.attempt !== null || entry === undefined) {
      return false;
    }
    this.begin(entry);
    return true;
  }

  /** Phone singers of an entry, owner first. */
  singersOf(entryId: string): MicSlot[] {
    const item = this.input.items.find((candidate) => candidate.entryId === entryId);
    return (item?.singers ?? []).filter(isMicSlot);
  }

  private evaluate(): void {
    const now = this.now();
    if (this.attempt !== null) {
      this.followAttempt(this.attempt, now);
      return;
    }
    if (!this.input.idle) {
      this.resetFocus(null);
      return;
    }
    const entry = this.input.entries.at(0);
    if (entry === undefined) {
      this.resetFocus(null);
      this.show({ kind: 'empty' }, LOBBY_STAGE);
      return;
    }
    if (entry.id !== this.focusId) {
      this.resetFocus(entry.id);
    }
    const singers = this.singersOf(entry.id);
    if (!this.input.autoStart) {
      this.countdownEndsAt = null;
      this.absentSince = null;
      this.show({ kind: 'held', entry, singers }, LOBBY_STAGE);
      return;
    }
    if (this.ownerPresent(singers)) {
      this.absentSince = null;
      this.countDown(entry, singers, now);
      return;
    }
    if (this.mayStartWithoutOwner(entry, now)) {
      this.countDown(entry, singers, now);
      return;
    }
    this.waitForOwner(entry, singers, now);
  }

  private ownerPresent(singers: readonly MicSlot[]): boolean {
    const owner = singers.at(0);
    if (owner === undefined) {
      return true;
    }
    return this.input.singers.some(
      (singer) => singer.slot === owner && singer.state === 'connected',
    );
  }

  /** After its one pass-over, an item whose owner is still away plays when its turn comes again. */
  private mayStartWithoutOwner(entry: ConductorEntry, now: number): boolean {
    return (
      this.passedOver.has(entry.id) &&
      this.absentSince !== null &&
      now - this.absentSince >= GRACE_MS &&
      this.input.entries.length > 1
    );
  }

  private countDown(entry: ConductorEntry, singers: MicSlot[], now: number): void {
    this.countdownEndsAt ??= now + COUNTDOWN_MS;
    const secondsLeft = Math.ceil((this.countdownEndsAt - now) / 1000);
    if (secondsLeft <= 0) {
      this.begin(entry);
      return;
    }
    this.show(
      { kind: 'countdown', entry, singers, secondsLeft },
      { ...LOBBY_STAGE, countdownSecs: secondsLeft },
    );
  }

  private waitForOwner(entry: ConductorEntry, singers: MicSlot[], now: number): void {
    const owner = singers[0];
    this.countdownEndsAt = null;
    this.absentSince ??= now;
    const waited = now - this.absentSince;
    const canPass = !this.passedOver.has(entry.id) && this.input.entries.length > 1;
    if (waited >= GRACE_MS && canPass) {
      this.passedOver.add(entry.id);
      this.ports.move(entry.id, 1);
      this.ports.notify(owner, 'passed-over', entry.title);
      this.resetFocus(null);
    }
    const secondsLeft = canPass ? Math.max(0, Math.ceil((GRACE_MS - waited) / 1000)) : null;
    this.show({ kind: 'waiting', entry, singers, owner, secondsLeft }, LOBBY_STAGE);
  }

  private begin(entry: ConductorEntry): void {
    const singers = this.singersOf(entry.id);
    const known = singers.flatMap((slot) => {
      const micId = this.input.mics.get(slot);
      return micId === undefined ? [] : [{ slot, microphoneId: remoteMicDeviceId(micId) }];
    });
    const players =
      known.length > 1
        ? known.map(({ slot, microphoneId }) => ({
            id: `slot-${slot}`,
            profile: null,
            microphoneId,
            color: slotColor(slot),
          }))
        : [];
    const scored = known.map(({ slot }) => slot);
    this.attempt = {
      entry,
      singers: scored,
      at: this.now(),
      sawPreparing: false,
      quietSince: null,
    };
    this.countdownEndsAt = null;
    this.show(
      { kind: 'starting', entry, singers: scored },
      {
        state: 'starting',
        entryId: entry.id,
        singers: scored,
        title: entry.title,
        artist: entry.artist,
      },
    );
    this.ports.start({
      entryId: entry.id,
      players,
      soloMicrophoneId: known.length === 1 ? known[0].microphoneId : null,
    });
  }

  /**
   * A start succeeds when its entry leaves the queue or the song opens. It
   * fails when the start ran and stopped with the entry still queued, or
   * never began at all.
   */
  private followAttempt(attempt: Attempt, now: number): void {
    const queued = this.input.entries.some((entry) => entry.id === attempt.entry.id);
    if (!queued || !this.input.idle) {
      this.attempt = null;
      this.resetFocus(null);
      return;
    }
    if (this.input.preparing) {
      attempt.sawPreparing = true;
      attempt.quietSince = null;
      return;
    }
    attempt.quietSince ??= now;
    const settled = attempt.sawPreparing && now - attempt.quietSince >= START_SETTLE_MS;
    const neverBegan = !attempt.sawPreparing && now - attempt.at >= START_NO_PROGRESS_MS;
    if (!settled && !neverBegan) {
      return;
    }
    this.attempt = null;
    this.resetFocus(null);
    this.ports.remove(attempt.entry.id);
    const owner = this.singersOf(attempt.entry.id).at(0);
    if (owner !== undefined) {
      this.ports.notify(owner, 'start-failed', attempt.entry.title);
    }
    this.show({ kind: 'empty' }, LOBBY_STAGE);
  }

  private resetFocus(entryId: string | null): void {
    this.focusId = entryId;
    this.countdownEndsAt = null;
    this.absentSince = null;
  }

  private show(status: LobbyStatus, stage: StageReport): void {
    this.current = status;
    this.ports.stage(stage);
  }
}
