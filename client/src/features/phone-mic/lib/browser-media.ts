import { meterFraction, rms } from './meter-math';
import type { MediaStartResult, MicMediaPort } from './ports';

/** Same capture policy as the desktop web adapter, plus mono (PROTOCOL.md §7). */
const CAPTURE_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  },
  video: false,
};

/** iOS mutes capture briefly on interruptions; only a lasting mute needs a new track. */
const MUTE_GRACE_MS = 500;
const RESUME_TIMEOUT_MS = 1_000;
const ANALYSER_FFT_SIZE = 2048;

const startResultFor = (error: unknown): MediaStartResult =>
  error instanceof DOMException &&
  (error.name === 'NotAllowedError' || error.name === 'SecurityError')
    ? 'denied'
    : 'unavailable';

const isRunning = (context: AudioContext): boolean => context.state === 'running';

const TRACK_SETTINGS = [
  'sampleRate',
  'channelCount',
  'echoCancellation',
  'noiseSuppression',
  'autoGainControl',
] as const;

const trackDiag = (track: MediaStreamTrack | null): Record<string, unknown> => {
  if (track === null) {
    return { trackState: null };
  }
  const settings = track.getSettings();
  return {
    ...Object.fromEntries(TRACK_SETTINGS.map((key) => [key, settings[key] ?? null])),
    trackState: track.readyState,
    trackMuted: track.muted,
  };
};

const contextDiag = (context: AudioContext | null): Record<string, unknown> =>
  context === null
    ? { contextState: null }
    : { contextState: context.state, contextRate: context.sampleRate };

const withTimeout = async (task: Promise<unknown>, ms: number): Promise<void> => {
  let timer = 0;
  try {
    await Promise.race([
      task,
      new Promise((resolve) => {
        timer = window.setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    window.clearTimeout(timer);
  }
};

/**
 * Microphone capture plus the level tap behind the meter. The audio context
 * only analyses the input; its output is a silent gain node, so the phone
 * never plays the singer's voice back.
 */
export class BrowserMicMedia implements MicMediaPort {
  private track: MediaStreamTrack | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Float32Array<ArrayBuffer> | null = null;
  private muteTimer: number | null = null;
  private unwatch: (() => void) | null = null;
  private enabled = true;
  private readonly troubleListeners: (() => void)[] = [];

  constructor(private readonly mediaDevices: MediaDevices | undefined) {}

  /** The live capture track the peer connection sends. */
  get currentTrack(): MediaStreamTrack | null {
    return this.track;
  }

  onTrouble(listener: () => void): void {
    this.troubleListeners.push(listener);
  }

  start(): Promise<MediaStartResult> {
    return this.capture();
  }

  restart(): Promise<MediaStartResult> {
    this.unwatchTrack();
    return this.capture();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.track !== null) {
      this.track.enabled = enabled;
    }
  }

  isHealthy(): boolean {
    return this.track?.readyState === 'live' && !this.track.muted;
  }

  async ensureMeterRunning(): Promise<boolean> {
    const context = this.context;
    if (context === null || isRunning(context)) {
      return true;
    }
    try {
      await withTimeout(context.resume(), RESUME_TIMEOUT_MS);
    } catch {
      return false;
    }
    return isRunning(context);
  }

  /** Current input level on the meter's 0..1 scale. */
  readLevel(): number {
    if (this.analyser === null || this.samples === null) {
      return 0;
    }
    this.analyser.getFloatTimeDomainData(this.samples);
    return meterFraction(rms(this.samples));
  }

  stop(): void {
    this.unwatchTrack();
    this.track?.stop();
    this.track = null;
    this.source?.disconnect();
    this.source = null;
  }

  settings(): Record<string, unknown> {
    return { ...trackDiag(this.track), ...contextDiag(this.context) };
  }

  private async capture(): Promise<MediaStartResult> {
    this.primeMeter();
    if (this.mediaDevices === undefined) {
      return 'unavailable';
    }

    let stream: MediaStream;
    try {
      stream = await this.mediaDevices.getUserMedia(CAPTURE_CONSTRAINTS);
    } catch (error) {
      return startResultFor(error);
    }

    const track = stream.getAudioTracks().at(0);
    if (track === undefined) {
      stream.getTracks().forEach((each) => each.stop());
      return 'unavailable';
    }
    this.adopt(stream, track);
    return 'ok';
  }

  /** Runs inside the tap, before any await, so iOS lets the context start. */
  private primeMeter(): void {
    this.context ??= new AudioContext({ latencyHint: 'interactive' });
    if (!isRunning(this.context)) {
      void this.ensureMeterRunning();
    }
  }

  private adopt(stream: MediaStream, track: MediaStreamTrack): void {
    this.unwatchTrack();
    this.track?.stop();
    this.track = track;
    track.enabled = this.enabled;
    this.watch(track);
    this.connectMeter(stream);
  }

  private connectMeter(stream: MediaStream): void {
    const context = this.context;
    if (context === null) {
      return;
    }
    if (this.analyser === null) {
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = ANALYSER_FFT_SIZE;
      this.samples = new Float32Array(ANALYSER_FFT_SIZE);
      const silence = context.createGain();
      silence.gain.value = 0;
      this.analyser.connect(silence);
      silence.connect(context.destination);
    }
    this.source?.disconnect();
    this.source = context.createMediaStreamSource(stream);
    this.source.connect(this.analyser);
  }

  private watch(track: MediaStreamTrack): void {
    const onEnded = (): void => this.emitTrouble();
    const onMute = (): void => {
      this.clearMuteTimer();
      this.muteTimer = window.setTimeout(() => {
        this.muteTimer = null;
        if (track.muted) {
          this.emitTrouble();
        }
      }, MUTE_GRACE_MS);
    };
    const onUnmute = (): void => this.clearMuteTimer();

    track.addEventListener('ended', onEnded);
    track.addEventListener('mute', onMute);
    track.addEventListener('unmute', onUnmute);
    this.unwatch = () => {
      track.removeEventListener('ended', onEnded);
      track.removeEventListener('mute', onMute);
      track.removeEventListener('unmute', onUnmute);
    };
  }

  private unwatchTrack(): void {
    this.clearMuteTimer();
    this.unwatch?.();
    this.unwatch = null;
  }

  private clearMuteTimer(): void {
    if (this.muteTimer !== null) {
      window.clearTimeout(this.muteTimer);
      this.muteTimer = null;
    }
  }

  private emitTrouble(): void {
    this.troubleListeners.forEach((listener) => listener());
  }
}
