import {
  MIX_PER_SEC,
  type FxSound,
  type MicPartyToServer,
  type MicSlot,
  type PartyAction,
  type ServerToMicParty,
} from '@/features/remote-mic/protocol';

import { takeToken } from './budget';
import {
  FX_RULE,
  initialPartyState,
  reduceParty,
  type MixValues,
  type PartyEvent,
  type PartyRequestKind,
  type PartyState,
  type PendingRequest,
  type ShiftValues,
} from './party-state';
import { stageSongKey } from './party-view';
import type { TimerPort } from './ports';
import type { PartyListener } from './session';

/** A request with no `ack` by then shows "That didn't reach the TV". */
export const ACK_TIMEOUT_MS = 5_000;
/** How long a notice or failure stays on screen. */
export const MESSAGE_MS = 6_000;
/** Mixer values sent are trusted this long before the snapshot's values win again. */
export const MIX_DRAFT_MS = 1_500;
const MIX_INTERVAL_MS = 1_000 / MIX_PER_SEC;
const MAX_REQ_ID = 0xffff_ffff;

export type PartyPorts = {
  /** Writes a party frame on the slot's socket; `false` while it is down. */
  send: (frame: MicPartyToServer) => boolean;
  timers: TimerPort;
};

export type ReserveRequest = {
  fileHash: string;
  keyOffset: number;
  tempo: number;
  singNext: boolean;
  partners: readonly MicSlot[];
};

export type ReservationChange = { keyOffset?: number; tempo?: number; singNext?: boolean };

type RequestFrame = Exclude<MicPartyToServer, { type: 'fx' | 'mix' }>;

/**
 * The phone's side of the party channel: numbers requests, waits for their
 * `ack`, mirrors the fx and mixer budgets and feeds {@link reduceParty}.
 */
export class PartyController implements PartyListener {
  private state: PartyState;
  private readonly listeners = new Set<() => void>();
  private lastReqId = 0;
  private mixSentAt = Number.NEGATIVE_INFINITY;
  private mixQueued: MixValues | null = null;
  private mixTimer: number | null = null;
  private draftTimer: number | null = null;

  private readonly ports: PartyPorts;

  constructor(ports: PartyPorts) {
    this.ports = ports;
    this.state = initialPartyState(ports.timers.now());
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): PartyState => this.state;

  onFrame(frame: ServerToMicParty): void {
    this.dispatch({ type: 'frame', frame, at: this.ports.timers.now() });
  }

  onSongResult(): void {
    this.dispatch({ type: 'song-result' });
  }

  onReset(): void {
    this.cancelMix();
    this.dispatch({ type: 'reset', at: this.ports.timers.now() });
  }

  reserve(request: ReserveRequest): void {
    this.request('reserve', (reqId) => ({
      type: 'reserve',
      reqId,
      fileHash: request.fileHash,
      ...(request.keyOffset === 0 ? {} : { keyOffset: request.keyOffset }),
      ...(request.tempo === 1 ? {} : { tempo: request.tempo }),
      ...(request.singNext ? { singNext: true } : {}),
      ...(request.partners.length === 0 ? {} : { partners: [...request.partners] }),
    }));
  }

  edit(reservationId: string, change: ReservationChange): void {
    this.request('edit', (reqId) => ({ type: 'edit', reqId, reservationId, ...change }));
  }

  cancel(reservationId: string): void {
    this.request('cancel', (reqId) => ({ type: 'cancel', reqId, reservationId }));
  }

  control(action: PartyAction): void {
    this.request('control', (reqId) => ({ type: 'control', reqId, action }));
  }

  shiftCurrent(values: ShiftValues): void {
    const stage = this.state.snapshot?.stage;
    if (stage === undefined) {
      return;
    }
    const shift = { ...values, songKey: stageSongKey(stage) };
    this.request('shift-current', (reqId) => ({ type: 'shift-current', reqId, ...values }), shift);
  }

  calibrate(): void {
    this.request('calibrate', (reqId) => ({ type: 'calibrate', reqId }));
  }

  /** Plays a fun sound if the fx budget (3, then one per 2 s) allows it; `true` when sent. */
  fx(sound: FxSound): boolean {
    const now = this.ports.timers.now();
    if (takeToken(this.state.fx, FX_RULE, now) === null) {
      return false;
    }
    if (!this.ports.send({ type: 'fx', sound })) {
      this.dispatch({ type: 'not-sent', kind: 'fx' });
      return false;
    }
    this.dispatch({ type: 'fx', at: now });
    return true;
  }

  /** At most {@link MIX_PER_SEC} `mix` frames a second; the newest values win. */
  mix(values: MixValues): void {
    this.dispatch({ type: 'mix-draft', values });
    this.mixQueued = { ...this.mixQueued, ...values };
    this.armDraftExpiry();
    if (this.mixTimer !== null) {
      return;
    }
    const wait = this.mixSentAt + MIX_INTERVAL_MS - this.ports.timers.now();
    if (wait <= 0) {
      this.flushMix();
      return;
    }
    this.mixTimer = this.ports.timers.setTimeout(() => {
      this.mixTimer = null;
      this.flushMix();
    }, wait);
  }

  dismiss(id: number): void {
    this.dispatch({ type: 'dismiss', id });
  }

  private flushMix(): void {
    const values = this.mixQueued;
    this.mixQueued = null;
    if (values === null) {
      return;
    }
    this.mixSentAt = this.ports.timers.now();
    this.ports.send({ type: 'mix', ...values });
  }

  private armDraftExpiry(): void {
    if (this.draftTimer !== null) {
      this.ports.timers.clearTimeout(this.draftTimer);
    }
    this.draftTimer = this.ports.timers.setTimeout(() => {
      this.draftTimer = null;
      this.dispatch({ type: 'mix-settled' });
    }, MIX_DRAFT_MS);
  }

  private cancelMix(): void {
    for (const timer of [this.mixTimer, this.draftTimer]) {
      if (timer !== null) {
        this.ports.timers.clearTimeout(timer);
      }
    }
    this.mixTimer = null;
    this.draftTimer = null;
    this.mixQueued = null;
  }

  private request(
    kind: PartyRequestKind,
    build: (reqId: number) => RequestFrame,
    shift?: PendingRequest['shift'],
  ): void {
    this.lastReqId = this.lastReqId >= MAX_REQ_ID ? 1 : this.lastReqId + 1;
    const reqId = this.lastReqId;
    if (!this.ports.send(build(reqId))) {
      this.dispatch({ type: 'not-sent', kind });
      return;
    }
    const sentAt = this.ports.timers.now();
    this.dispatch({
      type: 'sent',
      request: { reqId, kind, sentAt, ...(shift === undefined ? {} : { shift }) },
    });
    this.ports.timers.setTimeout(
      () => this.dispatch({ type: 'ack-timeout', reqId }),
      ACK_TIMEOUT_MS,
    );
  }

  private dispatch(event: PartyEvent): void {
    const before = this.state;
    this.state = reduceParty(before, event);
    if (this.state === before) {
      return;
    }
    this.scheduleDismissals(before.nextMessageId);
    this.listeners.forEach((listener) => listener());
  }

  private scheduleDismissals(firstNewId: number): void {
    for (let id = firstNewId; id < this.state.nextMessageId; id += 1) {
      this.ports.timers.setTimeout(() => this.dismiss(id), MESSAGE_MS);
    }
  }
}
