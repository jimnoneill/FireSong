import type { IceCandidate, IceServer } from '@/features/remote-mic/protocol';

import type { KeyValueStore } from './identity';

/** Wall clock and timers, so tests can drive time by hand. */
export type TimerPort = {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
  setInterval: (callback: () => void, ms: number) => number;
  clearInterval: (handle: number) => void;
};

export type SocketHandlers = {
  onOpen: () => void;
  onMessage: (data: string) => void;
  onClose: (code: number) => void;
};

/** One `/rtc` WebSocket. `close` never calls `onClose` back synchronously. */
export type SocketPort = {
  send: (data: string) => void;
  close: (code: number) => void;
};

export type OpenSocket = (url: string, handlers: SocketHandlers) => SocketPort;

export type MediaStartResult = 'ok' | 'denied' | 'unavailable';

/** The phone's microphone: capture, the level tap and their recovery. */
export type MicMediaPort = {
  /** Starts capture; call it from a tap so audio playback and capture may start. */
  start: () => Promise<MediaStartResult>;
  /** Asks for a new track (after a lock, an interruption or `ended`). */
  restart: () => Promise<MediaStartResult>;
  setEnabled: (enabled: boolean) => void;
  /** A live, unmuted track. */
  isHealthy: () => boolean;
  /** Resumes the level meter's audio context; `false` when it needs a tap. */
  ensureMeterRunning: () => Promise<boolean>;
  stop: () => void;
  settings: () => Record<string, unknown>;
  /** The track ended, or stayed muted, so it needs {@link MicMediaPort.restart}. */
  onTrouble: (listener: () => void) => void;
};

export type PeerLinkState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed';

export type AnswerOutcome = 'applied' | 'ignored' | 'failed';

/** The one send-only `RTCPeerConnection` to the TV. */
export type MicPeerPort = {
  /** Replaces any session with a new one; resolves the complete offer SDP, or `null` if superseded. */
  open: (iceServers: readonly IceServer[]) => Promise<string | null>;
  /** An ICE-restart offer on the current session, or `null` without one. */
  restartIce: () => Promise<string | null>;
  acceptAnswer: (sdp: string) => Promise<AnswerOutcome>;
  addRemoteCandidate: (candidate: IceCandidate | null) => Promise<void>;
  /** Hands the current capture track to the sender without renegotiating. */
  replaceTrack: () => Promise<void>;
  close: () => void;
  diag: () => Promise<Record<string, unknown>>;
  onStateChange: (listener: (state: PeerLinkState) => void) => void;
};

export type WakeLockState = 'idle' | 'held' | 'unavailable';

export type WakeLockPort = {
  acquire: () => Promise<WakeLockState>;
  release: () => void;
  /** The system dropped the lock (page hidden, battery saver). */
  onReleased: (listener: () => void) => void;
};

export type PagePort = {
  isVisible: () => boolean;
  onVisible: (listener: () => void) => void;
  /** `persisted` is `true` when the page came back from the back-forward cache. */
  onPageShow: (listener: (persisted: boolean) => void) => void;
};

/** The phone's network, as far as the browser tells (the Network Information API is Chromium only). */
export type NetworkPort = {
  /** `navigator.connection.type` (`wifi`, `cellular`, ...), or `null` where the browser has none. */
  type: () => string | null;
  /** The browser went `online`, or `navigator.connection` changed. */
  onChange: (listener: () => void) => void;
};

export type PhoneMicPorts = {
  socketUrl: string;
  openSocket: OpenSocket;
  media: MicMediaPort;
  peer: MicPeerPort;
  wakeLock: WakeLockPort;
  page: PagePort;
  network: NetworkPort;
  storage: KeyValueStore;
  timers: TimerPort;
  random: () => number;
  newMicId: () => string;
  userAgent: string;
  reportError: (error: unknown) => void;
};
