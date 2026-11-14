import { MicRack, type MicRackPort, type RackSlotStatus, type TapListener } from '@/audio/mic-rack';
import { SlotLatency } from '@/audio/slot-latency';
import { getVoiceEngine } from '@/audio/voice-engine';
import { slotMixFromPct, type EchoMix, type SlotMix } from '@/audio/voice-params';
import { installDiag } from '@/features/remote-mic/diag';
import {
  linkNoraebang,
  noraebangMonitorAlways,
  presetEchoMix,
} from '@/features/remote-mic/noraebang-link';
import {
  isMicSlot,
  MIC_LINKS_PATH,
  MIC_SLOTS,
  parseMicLinks,
  parseServerToTv,
  parseServerToTvParty,
  PROTOCOL_VERSION,
  parseRemoteMicDeviceId,
  remoteMicDeviceId,
  type IceCandidate,
  type IceServer,
  type LatencyMethod,
  type MicLinks,
  type MicSlot,
  type ServerToTv,
  type ServerToTvParty,
  type SlotLostReason,
  type TvPartyToServer,
  type TvSlot,
  type TvToServer,
} from '@/features/remote-mic/protocol';
import { t } from '@/i18n';
import { PLAYER_COLOR_OPTIONS } from '@/shared/player-colors';
import type { MicSampleFrame } from '@/types/MicSampleFrame';

import { fireSongLaunch } from './firesong-launch';
import { dispatchMicFrame } from './microphone-samples';
import { TvMicPeer, type PeerInit, type PeerPort, type PeerStats } from './remote-mic-peer';
import { createRtcSocket, rtcSocketUrl } from './rtc-socket';
import { isTauri } from './runtime';

/**
 * The TV's phone-mic registry (PROTOCOL.md §7-8). It holds the `/rtc` TV
 * seat, one receive-only peer per slot, and the MicRack that owns every phone
 * voice. Capture ids (players) bind to a `micId`; the slot's pre-FX tap then
 * feeds `dispatchMicFrame` for each bound id. Binding and unbinding never stop
 * tracks: streams live from join to leave.
 */

/** Effective latency moves smaller than this do not re-render scoring. */
const LATENCY_PUBLISH_STEP_MS = 5;

export type RemoteMicDevice = {
  id: string;
  micId: string;
  slot: MicSlot;
  label: string;
  reconnecting: boolean;
};

export type RemoteMicsSnapshot = {
  devices: readonly RemoteMicDevice[];
  /** Effective latency `L_i` per `micId`, only for calibrated mics. */
  latencyMs: ReadonlyMap<string, number>;
  connected: boolean;
  lastError: string | null;
};

/** Everything the TV can receive on `/rtc`: signaling (§5.4) and party frames (§13.6). */
export type TvInbound = ServerToTv | ServerToTvParty;

/** Everything the TV can send on `/rtc`. */
export type TvOutbound = TvToServer | TvPartyToServer;

export type TvSocketPort = { send(frame: TvOutbound): boolean; stop(): void };

/**
 * Party traffic for the TV's party client: the frames it handles, and `ready`
 * each time the TV seat is taken, so it can report its stage again.
 */
export type TvPartyEvent =
  | { kind: 'ready' }
  | { kind: 'frame'; frame: Exclude<ServerToTvParty, { type: 'mix' }> };

export type RemoteMicsDeps = {
  rack: () => Promise<MicRackPort>;
  connect: (onFrame: (frame: TvInbound) => void, onOpen: (open: boolean) => void) => TvSocketPort;
  createPeer: (init: PeerInit) => PeerPort;
  dispatchFrame: (captureId: string, frame: MicSampleFrame) => void;
  devicesChanged: () => void;
  label: (slot: TvSlot) => string;
  /** Monitor every slot with a phone, whatever the bindings say (noraebang mode). */
  monitorAlways: () => boolean;
  /** Echo and reverb levels for every slot (the echo preset). */
  echoMix: () => EchoMix;
};

type Binding = { micId: string; monitor: boolean };

type SlotFrame = Extract<ServerToTv, { type: 'offer' | 'ice' | 'mute' | 'slot-lost' }>;

type ActiveSlot = TvSlot & { slot: MicSlot; micId: string };

const PARTY_FRAME_TYPES: ReadonlySet<string> = new Set<ServerToTvParty['type']>([
  'party',
  'control',
  'shift-current',
  'fx',
  'mix',
  'calibrate',
]);

const isPartyFrame = (frame: TvInbound): frame is ServerToTvParty =>
  PARTY_FRAME_TYPES.has(frame.type);

const isActive = (slot: TvSlot): slot is ActiveSlot =>
  slot.state !== 'empty' && slot.micId !== undefined && isMicSlot(slot.slot);

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const EMPTY_SNAPSHOT: RemoteMicsSnapshot = {
  devices: [],
  latencyMs: new Map(),
  connected: false,
  lastError: null,
};

export class RemoteMics {
  private snapshot: RemoteMicsSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private readonly partyListeners = new Set<(event: TvPartyEvent) => void>();
  private readonly bindings = new Map<string, Binding>();
  private readonly mixes = new Map<MicSlot, SlotMix>();
  private lastParty: Extract<ServerToTvParty, { type: 'party' }> | null = null;
  private readonly peers = new Map<MicSlot, PeerPort>();
  private readonly latencies = new Map<string, SlotLatency>();
  private readonly tapped = new Set<MicSlot>();
  private roster: ActiveSlot[] = [];
  private iceServers: readonly IceServer[] = [];
  private rack: MicRackPort | null = null;
  private socket: TvSocketPort | null = null;
  private starts = 0;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private lastError: string | null = null;

  constructor(private readonly deps: RemoteMicsDeps) {}

  /** Takes the TV seat; the returned function gives it back. Reference counted. */
  start(): () => void {
    this.starts += 1;
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.starts === 1 && this.socket === null) {
      this.open().catch((error: unknown) => this.fail(error));
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.starts -= 1;
      if (this.starts === 0) {
        this.stopTimer = setTimeout(() => this.shutdown(), 0);
      }
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): RemoteMicsSnapshot => this.snapshot;

  /** Party frames and seat changes for the TV's party client, starting with the latest snapshot. */
  subscribeParty(listener: (event: TvPartyEvent) => void): () => void {
    this.partyListeners.add(listener);
    if (this.lastParty !== null) {
      listener({ kind: 'frame', frame: this.lastParty });
    }
    return () => {
      this.partyListeners.delete(listener);
    };
  }

  /** Sends a TV party frame (PROTOCOL.md §13.5); false while the TV seat is not held. */
  sendParty(frame: TvPartyToServer): boolean {
    return this.socket?.send(frame) ?? false;
  }

  devices(): readonly RemoteMicDevice[] {
    return this.snapshot.devices;
  }

  bind(captureId: string, micId: string, monitor: boolean): void {
    this.bindings.set(captureId, { micId, monitor });
    this.syncSlots();
  }

  /** Returns false when the capture id was not bound to a phone mic. */
  unbind(captureId: string): boolean {
    const bound = this.bindings.delete(captureId);
    if (bound) {
      this.syncSlots();
    }
    return bound;
  }

  /** Returns false when the capture id was not bound to a phone mic. */
  setMonitoring(captureId: string, monitor: boolean): boolean {
    const binding = this.bindings.get(captureId);
    if (binding === undefined) {
      return false;
    }
    binding.monitor = monitor;
    this.syncSlots();
    return true;
  }

  isBound(captureId: string): boolean {
    return this.bindings.has(captureId);
  }

  /** Re-reads `monitorAlways` and `echoMix`, after the noraebang settings change. */
  refreshSettings(): void {
    this.rack?.setEchoMix(this.deps.echoMix());
    this.syncSlots();
  }

  /** The roster slot of a `remote:<micId>` device id, or `null` (local, unknown, empty). */
  slotForMicrophone(deviceId: string): MicSlot | null {
    const micId = parseRemoteMicDeviceId(deviceId);
    if (micId === null) {
      return null;
    }
    return this.roster.find((entry) => entry.micId === micId)?.slot ?? null;
  }

  /** The name the phone in a `remote:<micId>` device id joined with, or `null`. */
  nameForMicrophone(deviceId: string): string | null {
    const micId = parseRemoteMicDeviceId(deviceId);
    if (micId === null) {
      return null;
    }
    return this.roster.find((entry) => entry.micId === micId)?.name ?? null;
  }

  /** Sends the score reveal's per-slot results to the phones (PROTOCOL.md §5.3). */
  sendSongResult(frame: Extract<TvToServer, { type: 'song-result' }>): boolean {
    return this.socket?.send(frame) ?? false;
  }

  /** Latest jitter-buffer delay of a mic's stream, in milliseconds. */
  jitterMs(micId: string): number | null {
    return this.latencies.get(micId)?.currentJitterMs() ?? null;
  }

  /** Live rack state of a slot: level, gate, feedback guard, echo. */
  slotStatus(slot: MicSlot): RackSlotStatus | null {
    return this.rack?.status(slot) ?? null;
  }

  /** Sends a calibrated mouth-to-speaker latency for the mic's slot. */
  reportLatency(micId: string, latencyMs: number, method: LatencyMethod): boolean {
    const slot = this.roster.find((entry) => entry.micId === micId);
    if (slot === undefined || this.socket === null) {
      return false;
    }
    return this.socket.send({ type: 'latency', slot: slot.slot, latencyMs, method });
  }

  setHostMute(slot: MicSlot, muted: boolean): boolean {
    return this.socket?.send({ type: 'mute', slot, muted }) ?? false;
  }

  kick(slot: MicSlot): boolean {
    return this.socket?.send({ type: 'kick', slot }) ?? false;
  }

  private async open(): Promise<void> {
    if (this.rack === null) {
      this.rack = await this.deps.rack();
      this.rack.setEchoMix(this.deps.echoMix());
    }
    if (this.starts === 0 || this.socket !== null) {
      return;
    }
    this.socket = this.deps.connect(
      (frame) => (isPartyFrame(frame) ? this.onPartyFrame(frame) : this.onFrame(frame)),
      (open) => {
        this.connected = open;
        this.publish();
      },
    );
  }

  private shutdown(): void {
    this.stopTimer = null;
    this.socket?.stop();
    this.socket = null;
    for (const slot of MIC_SLOTS) {
      this.releaseSlot(slot);
    }
    this.tapped.clear();
    this.roster = [];
    this.lastParty = null;
    this.connected = false;
    this.publish();
  }

  private onFrame(frame: ServerToTv): void {
    switch (frame.type) {
      case 'ready':
        this.iceServers = frame.iceServers;
        this.emitParty({ kind: 'ready' });
        return;
      case 'roster':
        this.applyRoster(frame.slots);
        return;
      case 'error':
        this.lastError = frame.code;
        this.publish();
        return;
      case 'diag':
      case 'pong':
        return;
      case 'offer':
      case 'ice':
      case 'mute':
      case 'slot-lost':
        this.onSlotFrame(frame);
    }
  }

  private onPartyFrame(frame: ServerToTvParty): void {
    if (frame.type === 'mix') {
      this.onMix(frame.slot, slotMixFromPct(frame.volumePct, frame.echoPct));
      return;
    }
    if (frame.type === 'party') {
      this.lastParty = frame;
    }
    this.emitParty({ kind: 'frame', frame });
  }

  private emitParty(event: TvPartyEvent): void {
    for (const listener of this.partyListeners) {
      listener(event);
    }
  }

  /** The slot's own mixer; kept for the slot's phone and applied once it is in the roster. */
  private onMix(slot: number, mix: SlotMix): void {
    if (!isMicSlot(slot)) {
      return;
    }
    this.mixes.set(slot, mix);
    if (this.roster.some((entry) => entry.slot === slot)) {
      this.rack?.setSlotMix(slot, mix);
    }
  }

  private onSlotFrame(frame: SlotFrame): void {
    switch (frame.type) {
      case 'offer':
        this.onOffer(frame.slot, frame.micId, frame.sdp, frame.restart);
        break;
      case 'ice':
        this.onIce(frame.slot, frame.micId, frame.candidate);
        break;
      case 'mute':
        if (isMicSlot(frame.slot)) {
          this.rack?.setMuted(frame.slot, frame.muted);
        }
        break;
      case 'slot-lost':
        this.onSlotLost(frame.slot, frame.micId, frame.reason);
        break;
    }
  }

  private applyRoster(slots: readonly TvSlot[]): void {
    const next = slots.filter(isActive);
    for (const previous of this.roster) {
      const current = next.find((entry) => entry.slot === previous.slot);
      if (current?.micId !== previous.micId) {
        this.releaseSlot(previous.slot);
      }
    }
    this.roster = next;
    for (const entry of next) {
      const latency = this.latencyFor(entry.micId);
      latency.setCalibrated(entry.latencyMs ?? null);
      this.rack?.setMuted(entry.slot, entry.muted);
      this.rack?.setLatency(entry.slot, latency.effectiveMs());
      const mix = this.mixes.get(entry.slot);
      if (mix !== undefined) {
        this.rack?.setSlotMix(entry.slot, mix);
      }
    }
    this.syncSlots();
  }

  private onOffer(slot: number, micId: string, sdp: string, restart: boolean): void {
    if (!isMicSlot(slot)) {
      return;
    }
    const existing = this.peers.get(slot);
    if (restart && existing?.micId === micId) {
      existing.acceptOffer(sdp).catch((error: unknown) => this.fail(error));
      return;
    }
    existing?.close();
    this.latencyFor(micId).resetJitter();
    const peer = this.deps.createPeer({
      micId,
      iceServers: this.iceServers,
      events: {
        onStream: (stream) => this.onStream(slot, micId, stream),
        onAnswer: (answer) => this.socket?.send({ type: 'answer', slot, sdp: answer }),
        onRestartNeeded: () => this.socket?.send({ type: 'restart', slot }),
        onStats: (stats) => this.onStats(slot, micId, stats),
        onError: (error) => this.fail(error),
      },
    });
    this.peers.set(slot, peer);
    peer.acceptOffer(sdp).catch((error: unknown) => this.fail(error));
  }

  private onIce(slot: number, micId: string, candidate: IceCandidate | null): void {
    const peer = isMicSlot(slot) ? this.peers.get(slot) : undefined;
    if (peer?.micId === micId) {
      peer.addIce(candidate);
    }
  }

  private onStream(slot: MicSlot, micId: string, stream: MediaStream): void {
    if (this.peers.get(slot)?.micId !== micId) {
      return;
    }
    this.rack?.attach(slot, stream);
    this.syncSlots();
  }

  private onStats(slot: MicSlot, micId: string, stats: PeerStats): void {
    if (stats.jitterMs === null) {
      return;
    }
    const latency = this.latencyFor(micId);
    const before = latency.effectiveMs();
    latency.observeJitter(stats.jitterMs);
    const after = latency.effectiveMs();
    this.rack?.setLatency(slot, after);
    const moved =
      before === null || after === null
        ? before !== after
        : Math.abs(after - before) >= LATENCY_PUBLISH_STEP_MS;
    if (moved) {
      this.publish();
    }
  }

  private onSlotLost(slot: number, micId: string, reason: SlotLostReason): void {
    if (!isMicSlot(slot)) {
      return;
    }
    const peer = this.peers.get(slot);
    if (peer?.micId === micId) {
      peer.close();
      this.peers.delete(slot);
    }
    if (reason === 'disconnected' || reason === 'replaced') {
      this.rack?.detach(slot);
    } else {
      this.releaseSlot(slot);
    }
  }

  private releaseSlot(slot: MicSlot): void {
    this.peers.get(slot)?.close();
    this.peers.delete(slot);
    this.tapped.delete(slot);
    this.mixes.delete(slot);
    this.rack?.release(slot);
  }

  private latencyFor(micId: string): SlotLatency {
    let latency = this.latencies.get(micId);
    if (latency === undefined) {
      latency = new SlotLatency();
      this.latencies.set(micId, latency);
    }
    return latency;
  }

  /** Points each slot's tap and monitor at the current bindings. */
  private syncSlots(): void {
    for (const entry of this.roster) {
      const bound = [...this.bindings.values()].filter((binding) => binding.micId === entry.micId);
      this.syncTap(entry, bound.length > 0);
      const monitor = this.deps.monitorAlways() || bound.some((binding) => binding.monitor);
      this.rack?.setMonitor(entry.slot, monitor);
    }
    this.publish();
  }

  private syncTap(entry: ActiveSlot, wanted: boolean): void {
    if (wanted === this.tapped.has(entry.slot)) {
      return;
    }
    if (!wanted) {
      this.tapped.delete(entry.slot);
      this.rack?.setTap(entry.slot, null);
      return;
    }
    this.tapped.add(entry.slot);
    this.rack?.setTap(entry.slot, this.tapListener(entry.micId));
    this.rack?.learnGateFloor(entry.slot);
  }

  private tapListener(micId: string): TapListener {
    return (samples, sampleRate) => {
      const frame: MicSampleFrame = { sample_rate: sampleRate, samples: Array.from(samples) };
      for (const [captureId, binding] of this.bindings) {
        if (binding.micId === micId) {
          this.deps.dispatchFrame(captureId, frame);
        }
      }
    };
  }

  private fail(error: unknown): void {
    this.lastError = errorText(error);
    this.publish();
  }

  private publish(): void {
    const devices = this.roster.map((entry) => ({
      id: remoteMicDeviceId(entry.micId),
      micId: entry.micId,
      slot: entry.slot,
      label: this.deps.label(entry),
      reconnecting: entry.state === 'reserved',
    }));
    const latencyMs = new Map<string, number>();
    for (const entry of this.roster) {
      const effective = this.latencies.get(entry.micId)?.effectiveMs() ?? null;
      if (effective !== null) {
        latencyMs.set(entry.micId, effective);
      }
    }
    const next = { devices, latencyMs, connected: this.connected, lastError: this.lastError };
    if (snapshotKey(next) === snapshotKey(this.snapshot)) {
      return;
    }
    const devicesChanged = deviceKey(devices) !== deviceKey(this.snapshot.devices);
    this.snapshot = next;
    if (devicesChanged) {
      this.deps.devicesChanged();
    }
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const deviceKey = (devices: readonly RemoteMicDevice[]): string =>
  JSON.stringify(devices.map((device) => [device.id, device.label]));

const snapshotKey = (snapshot: RemoteMicsSnapshot): string =>
  JSON.stringify([
    snapshot.devices,
    [...snapshot.latencyMs],
    snapshot.connected,
    snapshot.lastError,
  ]);

const slotLabel = (slot: TvSlot): string => {
  const color = PLAYER_COLOR_OPTIONS.find((option) => option.value === slot.color);
  const name = slot.name ?? (color === undefined ? slot.color : t(color.label));
  const device = t('firesong.remoteMic.deviceName', { slot: slot.slot, name });
  return slot.state === 'reserved' ? t('firesong.remoteMic.reconnecting', { device }) : device;
};

const notifyDeviceChange = (): void => {
  if (typeof navigator !== 'undefined' && 'mediaDevices' in navigator) {
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  }
};

const connectTv: RemoteMicsDeps['connect'] = (onFrame, onOpen) =>
  createRtcSocket<TvInbound, TvOutbound>({
    url: () => rtcSocketUrl(window.location.href),
    hello: () => ({ type: 'hello', v: PROTOCOL_VERSION }),
    ping: (now) => ({ type: 'ping', t: now }),
    parse: (raw) => parseServerToTv(raw) ?? parseServerToTvParty(raw),
    isPong: (frame) => frame.type === 'pong',
    onFrame,
    onStatus: (status) => onOpen(status.state === 'open'),
  });

/** The four per-slot join links and QR codes (PROTOCOL.md §1.1); the TV door only. */
export const loadMicLinks = async (): Promise<MicLinks> => {
  const response = await fetch(MIC_LINKS_PATH, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return parseMicLinks(await response.json());
};

let rackPromise: Promise<MicRackPort> | null = null;

export const remoteMics = new RemoteMics({
  rack: () => {
    rackPromise ??= MicRack.create(getVoiceEngine());
    return rackPromise;
  },
  connect: connectTv,
  createPeer: (init) => new TvMicPeer(init),
  dispatchFrame: dispatchMicFrame,
  devicesChanged: notifyDeviceChange,
  label: slotLabel,
  monitorAlways: noraebangMonitorAlways,
  echoMix: presetEchoMix,
});

/**
 * Starts the phone-mic registry on the TV (`?tv=1`) only, so an operator's
 * browser on the same server never takes the TV seat from the Fire TV.
 */
export const startRemoteMics = (): (() => void) => {
  if (isTauri || !fireSongLaunch().tv) {
    return () => undefined;
  }
  const release = remoteMics.start();
  const unlink = linkNoraebang(remoteMics);
  const uninstallDiag = installDiag(remoteMics);
  return () => {
    uninstallDiag();
    unlink();
    release();
  };
};
