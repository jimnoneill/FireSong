import { BrowserMicMedia } from './browser-media';
import type { KeyValueStore } from './identity';
import { joinLinkSlot, rtcSocketUrl } from './join-link';
import { PeerLink } from './peer-link';
import type { OpenSocket, PagePort, TimerPort, WakeLockPort, WakeLockState } from './ports';
import { PhoneMicSession } from './session';

const openWebSocket: OpenSocket = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.addEventListener('open', () => handlers.onOpen());
  socket.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (typeof event.data === 'string') {
      handlers.onMessage(event.data);
    }
  });
  socket.addEventListener('close', (event) => handlers.onClose(event.code));
  return {
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data);
      }
    },
    close: (code) => socket.close(code),
  };
};

const windowTimers: TimerPort = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
  setInterval: (callback, ms) => window.setInterval(callback, ms),
  clearInterval: (handle) => window.clearInterval(handle),
};

const documentPage: PagePort = {
  isVisible: () => document.visibilityState === 'visible',
  onVisible: (listener) =>
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        listener();
      }
    }),
  onPageShow: (listener) =>
    window.addEventListener('pageshow', (event) => listener(event.persisted)),
};

/** `false` when the browser refuses storage (private modes, quota). */
const tryStorage = (action: (storage: Storage) => void): boolean => {
  try {
    action(window.localStorage);
    return true;
  } catch {
    return false;
  }
};

/** `localStorage` behind an in-memory copy, so a refusing browser still works for this visit. */
const browserStore = (): KeyValueStore => {
  const memory = new Map<string, string | null>();
  return {
    get: (key) => {
      if (!memory.has(key)) {
        let value: string | null = null;
        tryStorage((storage) => {
          value = storage.getItem(key);
        });
        memory.set(key, value);
      }
      return memory.get(key) ?? null;
    },
    set: (key, value) => {
      memory.set(key, value);
      tryStorage((storage) => storage.setItem(key, value));
    },
    remove: (key) => {
      memory.set(key, null);
      tryStorage((storage) => storage.removeItem(key));
    },
  };
};

const newMicId = (): string => crypto.randomUUID();

/** Holds the screen awake while singing; the system may drop it when hidden. */
class ScreenWakeLock implements WakeLockPort {
  private sentinel: WakeLockSentinel | null = null;
  /** Bumped by {@link ScreenWakeLock.release}, so a late grant is handed straight back. */
  private releases = 0;
  private readonly releasedListeners: (() => void)[] = [];

  constructor(private readonly wakeLock: WakeLock | undefined) {}

  onReleased(listener: () => void): void {
    this.releasedListeners.push(listener);
  }

  async acquire(): Promise<WakeLockState> {
    const releases = this.releases;
    if (this.wakeLock === undefined) {
      return 'unavailable';
    }
    if (this.sentinel !== null) {
      return 'held';
    }
    try {
      const sentinel = await this.wakeLock.request('screen');
      if (releases !== this.releases) {
        await sentinel.release();
        return 'idle';
      }
      this.sentinel = sentinel;
      sentinel.addEventListener('release', () => this.handleSystemRelease(sentinel));
      return 'held';
    } catch {
      return 'unavailable';
    }
  }

  release(): void {
    this.releases += 1;
    const sentinel = this.sentinel;
    this.sentinel = null;
    void sentinel?.release().catch((error: unknown) => reportError(error));
  }

  private handleSystemRelease(sentinel: WakeLockSentinel): void {
    if (this.sentinel === sentinel) {
      this.sentinel = null;
      this.releasedListeners.forEach((listener) => listener());
    }
  }
}

export type BrowserPhoneMic = {
  session: PhoneMicSession;
  /** Current input level on a 0..1 scale, for the meter. */
  readLevel: () => number;
};

/** Composition root of the phone page: real browser ports into the session. */
export const createBrowserPhoneMic = (): BrowserPhoneMic => {
  const media = new BrowserMicMedia(
    'mediaDevices' in navigator ? navigator.mediaDevices : undefined,
  );
  const peer = new PeerLink<MediaStreamTrack>({
    createPeer: (config) => new RTCPeerConnection(config),
    currentTrack: () => media.currentTrack,
    timers: windowTimers,
  });

  const session = new PhoneMicSession(
    {
      socketUrl: rtcSocketUrl(window.location),
      openSocket: openWebSocket,
      media,
      peer,
      wakeLock: new ScreenWakeLock('wakeLock' in navigator ? navigator.wakeLock : undefined),
      page: documentPage,
      storage: browserStore(),
      timers: windowTimers,
      random: Math.random,
      newMicId,
      userAgent: navigator.userAgent,
      reportError: (error) => reportError(error),
    },
    joinLinkSlot(window.location.search),
  );

  return { session, readLevel: () => media.readLevel() };
};
