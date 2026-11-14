import { useSyncExternalStore } from 'react';

import {
  isMicSlot,
  MAX_COUNTDOWN_SECS,
  MAX_LYRIC_CHARS,
  MAX_TITLE_CHARS,
  type FxSound,
  type MicSlot,
  type NoticeCode,
  type PartySnapshot,
  type TvPartyToServer,
} from '@/features/remote-mic/protocol';

/**
 * The TV's side of the party channel (PROTOCOL.md §13). The `/rtc` socket
 * attaches itself as the sink; the lobby, the playback screen and the lyric
 * bar report through here and register the controls phones may drive. Until
 * a sink is attached (an ordinary browser), reports go nowhere.
 */

export type StageFrame = Extract<TvPartyToServer, { type: 'stage' }>;
export type StageReport = Omit<StageFrame, 'type'>;
export type LyricFrame = Extract<TvPartyToServer, { type: 'lyric' }>;

export type PartySink = { send(frame: TvPartyToServer): boolean };

/** What a playing song lets the phone remote do (PROTOCOL.md §13.6). */
export type PlaybackControls = {
  pause(): void;
  resume(): void;
  stop(): void;
  shift(slot: MicSlot, keyOffset: number, tempo: number): void;
};

export type LobbyControls = { startNow(): void };

export type FxFlash = { id: number; slot: MicSlot; sound: FxSound };

export type PartyTvState = {
  snapshot: PartySnapshot | null;
  /** Fun sounds that just played, newest last. */
  flashes: readonly FxFlash[];
  /** The slot whose phone is being calibrated. */
  tuning: MicSlot | null;
  /** A key or tempo change of the current song is rendering. */
  shifting: boolean;
  stage: StageReport;
  /** Songs opened on this TV since the page loaded. */
  songs: number;
};

export const LOBBY_STAGE: StageReport = { state: 'lobby', singers: [] };

const FLASH_MS = 1600;
const MAX_FLASHES = 4;

/** Rust's `char::is_control`: the C0 and C1 control characters. */
const isControl = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
};

/** Text for the wire: control characters become spaces, cut to `max` code points as Rust counts them. */
export const wireText = (text: string, max: number): string =>
  Array.from(
    Array.from(text)
      .map((char) => (isControl(char) ? ' ' : char))
      .join('')
      .trim(),
  )
    .slice(0, max)
    .join('');

const PARTY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** A queue entry id the server accepts in `stage` (`is_valid_party_id`). */
export const isPartyId = (id: string): boolean => PARTY_ID.test(id);

const optionalText = (key: 'title' | 'artist', text: string | undefined) => {
  const clean = text === undefined ? '' : wireText(text, MAX_TITLE_CHARS);
  return clean === '' ? {} : { [key]: clean };
};

/** A stage the server accepts: valid id, distinct slots, short texts, countdown in range. */
export const cleanStage = (stage: StageReport): StageReport => ({
  state: stage.state,
  ...(stage.entryId !== undefined && isPartyId(stage.entryId) ? { entryId: stage.entryId } : {}),
  singers: stage.singers.filter(
    (slot, index) => isMicSlot(slot) && stage.singers.indexOf(slot) === index,
  ),
  ...optionalText('title', stage.title),
  ...optionalText('artist', stage.artist),
  ...(stage.countdownSecs === undefined
    ? {}
    : {
        countdownSecs: Math.min(MAX_COUNTDOWN_SECS, Math.max(0, Math.round(stage.countdownSecs))),
      }),
});

const stageKey = (stage: StageReport): string =>
  JSON.stringify([
    stage.state,
    stage.entryId ?? null,
    stage.singers,
    stage.title ?? null,
    stage.artist ?? null,
    stage.countdownSecs ?? null,
  ]);

export class PartyTv {
  private state: PartyTvState = {
    snapshot: null,
    flashes: [],
    tuning: null,
    shifting: false,
    stage: LOBBY_STAGE,
    songs: 0,
  };
  private readonly listeners = new Set<() => void>();
  private sink: PartySink | null = null;
  private sentStage: string | null = null;
  private playback: PlaybackControls | null = null;
  private lobby: LobbyControls | null = null;
  private flashId = 0;
  private playingEntryId: string | null = null;
  private readonly fxCounts = { played: 0, dropped: 0 };

  constructor(
    private readonly timers: {
      setTimeout(fn: () => void, ms: number): unknown;
    } = { setTimeout: (fn, ms) => setTimeout(fn, ms) },
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): PartyTvState => this.state;

  /** Called by the TV socket; returns the detach function. */
  attachSink(sink: PartySink): () => void {
    this.sink = sink;
    this.sentStage = null;
    return () => {
      if (this.sink === sink) {
        this.sink = null;
        this.sentStage = null;
        this.update({ snapshot: null });
      }
    };
  }

  /** The TV seat was taken again: the server knows nothing of our stage. */
  onReady(): void {
    this.sentStage = null;
    this.flushStage();
  }

  setSnapshot(snapshot: PartySnapshot): void {
    this.update({ snapshot });
  }

  /** Reports what the TV shows; sends `stage` only when it changed. */
  reportStage(report: StageReport): void {
    const stage = cleanStage(report);
    if (stageKey(stage) !== stageKey(this.state.stage)) {
      this.update({ stage });
    }
    this.flushStage();
  }

  sendLyric(frame: Omit<LyricFrame, 'type'>): boolean {
    const clean = {
      ...frame,
      ...(frame.line === undefined ? {} : { line: wireText(frame.line, MAX_LYRIC_CHARS) }),
      ...(frame.next === undefined ? {} : { next: wireText(frame.next, MAX_LYRIC_CHARS) }),
    };
    return this.send({ type: 'lyric', ...clean });
  }

  notify(slot: MicSlot, code: NoticeCode, title?: string): boolean {
    const text = title === undefined ? '' : wireText(title, MAX_TITLE_CHARS);
    return this.send(
      text === '' ? { type: 'notify', slot, code } : { type: 'notify', slot, code, title: text },
    );
  }

  resetScores(): boolean {
    return this.send({ type: 'reset-scores' });
  }

  send(frame: TvPartyToServer): boolean {
    return this.sink?.send(frame) ?? false;
  }

  /** The current song's controls; returns the unregister function. */
  registerPlayback(controls: PlaybackControls): () => void {
    this.playback = controls;
    this.update({ songs: this.state.songs + 1 });
    return () => {
      if (this.playback === controls) {
        this.playback = null;
      }
    };
  }

  registerLobby(controls: LobbyControls): () => void {
    this.lobby = controls;
    return () => {
      if (this.lobby === controls) {
        this.lobby = null;
      }
    };
  }

  /** A phone remote action the server already authorised (PROTOCOL.md §13.6 `control`). */
  control(action: 'pause' | 'resume' | 'stop' | 'start-now'): void {
    switch (action) {
      case 'pause':
        this.playback?.pause();
        return;
      case 'resume':
        this.playback?.resume();
        return;
      case 'stop':
        this.playback?.stop();
        return;
      case 'start-now':
        this.lobby?.startNow();
    }
  }

  shiftCurrent(slot: MicSlot, keyOffset: number, tempo: number): void {
    if (this.playback === null) {
      this.notify(slot, 'shift-failed');
      return;
    }
    this.playback.shift(slot, keyOffset, tempo);
  }

  /** Fun sounds played and dropped since the page loaded, for `fireSongDiag`. */
  fxCounters(): { played: number; dropped: number } {
    return { ...this.fxCounts };
  }

  countDroppedFx(): void {
    this.fxCounts.dropped += 1;
  }

  /** A fun sound played: count it and flash its sender's colour. */
  flash(slot: MicSlot, sound: FxSound): void {
    this.fxCounts.played += 1;
    this.flashId += 1;
    const flash = { id: this.flashId, slot, sound };
    this.update({ flashes: [...this.state.flashes, flash].slice(-MAX_FLASHES) });
    this.timers.setTimeout(() => {
      this.update({ flashes: this.state.flashes.filter((entry) => entry.id !== flash.id) });
    }, FLASH_MS);
  }

  setTuning(tuning: MicSlot | null): void {
    this.update({ tuning });
  }

  setShifting(shifting: boolean): void {
    this.update({ shifting });
  }

  /** The queue entry the lobby started, so the playback screen can name it in `stage`. */
  setPlayingEntry(entryId: string | null): void {
    this.playingEntryId = entryId;
  }

  playingEntry(): string | null {
    return this.playingEntryId;
  }

  private flushStage(): void {
    const key = stageKey(this.state.stage);
    if (key === this.sentStage || this.sink === null) {
      return;
    }
    if (this.sink.send({ type: 'stage', ...this.state.stage })) {
      this.sentStage = key;
    }
  }

  private update(patch: Partial<PartyTvState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const partyTv = new PartyTv();

export function usePartyTv(): PartyTvState {
  return useSyncExternalStore(partyTv.subscribe, partyTv.getState);
}
