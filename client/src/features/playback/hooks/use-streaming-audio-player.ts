/**
 * Streaming playback for the self-hosted web app, which the TV runs. The
 * instrumental and guide vocal stems play from media elements that fetch them
 * in ranges as they play, through the page's one voice engine context, so a
 * song never sits whole in memory and starts as soon as its first seconds
 * arrive. The clock is the instrumental element's media time.
 *
 * Scoring needs the vocal waveform ahead of the singer, so a small mono copy
 * (24 kHz) of the scoring stem is decoded beside playback; it may arrive a
 * moment after the song is ready, and `getScoringBuffer` changes when it does.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getVoiceEngine } from '@/audio/voice-engine';
import { addFlightSampler, flight } from '@/bridge/flight';
import type { PlaybackAdapter } from '@/bridge/playback';
import { playbackAdapter } from '@/bridge/playback';
import { t } from '@/i18n';
import type { AudioPaths } from '@/types/Transcript';

import type { AudioPlayer, TimeSubscriber } from './use-audio-player';

const SCORING_SAMPLE_RATE = 24_000;
/** The guide vocal follows the instrumental when they drift further apart, seconds. */
const GUIDE_DRIFT_SEC = 0.08;
const NOTIFY_INTERVAL_MS = 33;

type InitialVolumes = { guide: number; master: number };

type Stems = {
  context: AudioContext;
  guide: GainNode;
  instrumental: HTMLAudioElement;
  vocals: HTMLAudioElement | null;
  release: () => void;
};

const unit = (value: number): number => Math.max(0, Math.min(1, value));

const mediaElement = (url: string): HTMLAudioElement => {
  const element = new Audio();
  element.preload = 'auto';
  element.src = url;
  return element;
};

const connectStems = (paths: AudioPaths, volumes: InitialVolumes): Stems => {
  const { context } = getVoiceEngine();
  const master = context.createGain();
  master.gain.value = unit(volumes.master);
  master.connect(context.destination);
  const guide = context.createGain();
  guide.gain.value = unit(volumes.guide);
  guide.connect(master);

  const instrumental = mediaElement(paths.instrumental);
  const sources = [context.createMediaElementSource(instrumental)];
  sources[0].connect(master);
  const vocals = paths.vocals === null ? null : mediaElement(paths.vocals);
  if (vocals !== null) {
    const source = context.createMediaElementSource(vocals);
    source.connect(guide);
    sources.push(source);
  }

  const release = () => {
    for (const element of [instrumental, vocals]) {
      element?.pause();
      element?.removeAttribute('src');
      element?.load();
    }
    for (const source of sources) {
      source.disconnect();
    }
    guide.disconnect();
    master.disconnect();
  };
  return { context, guide, instrumental, vocals, release };
};

const mediaError = (element: HTMLAudioElement): Error => {
  const message = element.error?.message ?? '';
  return new Error(message === '' ? `media error ${element.error?.code ?? 0}` : message);
};

/** Resolves once the element can play on without stalling right away. */
const canPlay = (element: HTMLAudioElement): Promise<void> =>
  new Promise((resolve, reject) => {
    if (element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      resolve();
      return;
    }
    element.addEventListener('canplay', () => resolve(), { once: true });
    element.addEventListener('error', () => reject(mediaError(element)), { once: true });
  });

/** A mono copy of `url` at the scoring rate; scoring reads one channel. */
const decodeScoringReference = async (url: string): Promise<AudioBuffer> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(t('playback.audio.vocalsFetchError', { status: response.status }));
  }
  const decoder = new OfflineAudioContext(1, 1, SCORING_SAMPLE_RATE);
  const decoded = await decoder.decodeAudioData(await response.arrayBuffer());
  if (decoded.numberOfChannels === 1) {
    return decoded;
  }
  const mono = new AudioBuffer({
    length: decoded.length,
    numberOfChannels: 1,
    sampleRate: decoded.sampleRate,
  });
  mono.copyToChannel(decoded.getChannelData(0), 0);
  return mono;
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Keeps the guide vocal on the instrumental's time. */
const followInstrumental = (stems: Stems): void => {
  const { instrumental, vocals } = stems;
  if (vocals === null || vocals.paused) {
    return;
  }
  if (Math.abs(vocals.currentTime - instrumental.currentTime) > GUIDE_DRIFT_SEC) {
    vocals.currentTime = instrumental.currentTime;
  }
};

export function useStreamingAudioPlayer(
  fileHash: string,
  initialVolumes: InitialVolumes,
  enabled: boolean,
  adapter: PlaybackAdapter = playbackAdapter,
): AudioPlayer {
  const { guide: initialGuideVolume, master: initialMasterVolume } = initialVolumes;
  const stemsRef = useRef<Stems | null>(null);
  const subscribersRef = useRef<Set<TimeSubscriber>>(new Set());
  const playingRef = useRef(false);

  const [duration, setDuration] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guideVolume, setGuideVolumeState] = useState(initialGuideVolume);
  const [guideAvailable, setGuideAvailable] = useState(true);
  const [scoring, setScoring] = useState<AudioBuffer | null>(null);

  const getCurrentTime = useCallback(() => stemsRef.current?.instrumental.currentTime ?? 0, []);
  const getScoringBuffer = useCallback(() => scoring, [scoring]);
  const getVocalsBuffer = useCallback(
    () => (guideAvailable ? scoring : null),
    [guideAvailable, scoring],
  );
  const getAudioContext = useCallback(() => stemsRef.current?.context ?? null, []);

  const subscribe = useCallback((fn: TimeSubscriber) => {
    subscribersRef.current.add(fn);
    return () => {
      subscribersRef.current.delete(fn);
    };
  }, []);

  const notifySubscribers = useCallback((time: number) => {
    for (const fn of subscribersRef.current) {
      fn(time);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    let cancelled = false;
    const isCancelled = () => cancelled;
    let frame = 0;
    let lastNotify = 0;
    const loadStarted = performance.now();
    const elapsedMs = () => Math.round(performance.now() - loadStarted);
    flight('song-load', { hash: fileHash, streaming: true });

    const onEnded = () => {
      playingRef.current = false;
      setIsFinished(true);
      setIsPlaying(false);
    };

    const load = async () => {
      const paths = await adapter.getAudioPaths(fileHash);
      if (isCancelled()) {
        return;
      }
      const stems = connectStems(paths, { guide: initialGuideVolume, master: initialMasterVolume });
      stemsRef.current = stems;
      stems.instrumental.addEventListener('ended', onEnded);
      setGuideAvailable(paths.vocals !== null);
      decodeScoringReference(paths.vocals ?? paths.instrumental)
        .then((buffer) => {
          flight('scoring-ready', { hash: fileHash, ms: elapsedMs() });
          if (!isCancelled()) {
            setScoring(buffer);
          }
          return undefined;
        })
        .catch((cause: unknown) => {
          flight('scoring-error', { hash: fileHash, message: errorText(cause) });
        });
      await Promise.all([
        canPlay(stems.instrumental),
        stems.vocals === null ? undefined : canPlay(stems.vocals),
      ]);
      if (isCancelled()) {
        return;
      }
      setDuration(stems.instrumental.duration);
      setIsReady(true);
      flight('song-ready', { hash: fileHash, ms: elapsedMs(), streaming: true });
    };

    load().catch((cause: unknown) => {
      flight('song-error', { hash: fileHash, ms: elapsedMs(), message: errorText(cause) });
      if (!isCancelled()) {
        setError(t('playback.audio.loadError', { error: errorText(cause) }));
      }
    });

    const tick = () => {
      const stems = stemsRef.current;
      const now = performance.now();
      if (stems !== null && playingRef.current && now - lastNotify >= NOTIFY_INTERVAL_MS) {
        lastNotify = now;
        followInstrumental(stems);
        notifySubscribers(stems.instrumental.currentTime);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    const removeSampler = addFlightSampler('song', () => ({
      hash: fileHash,
      streaming: true,
      playing: playingRef.current,
      timeSec: Math.round(stemsRef.current?.instrumental.currentTime ?? 0),
      buffered: stemsRef.current?.instrumental.buffered.length ?? 0,
    }));

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      removeSampler();
      flight('song-unload', {
        hash: fileHash,
        timeSec: Math.round(stemsRef.current?.instrumental.currentTime ?? 0),
      });
      playingRef.current = false;
      stemsRef.current?.instrumental.removeEventListener('ended', onEnded);
      stemsRef.current?.release();
      stemsRef.current = null;
    };
  }, [adapter, enabled, fileHash, initialGuideVolume, initialMasterVolume, notifySubscribers]);

  const start = useCallback((event: string) => {
    const stems = stemsRef.current;
    if (stems === null) {
      return;
    }
    playingRef.current = true;
    setIsPlaying(true);
    flight(event, { timeSec: Math.round(stems.instrumental.currentTime) });
    const elements = [stems.instrumental, stems.vocals].filter((element) => element !== null);
    void stems.context.resume().catch(() => undefined);
    Promise.all(elements.map((element) => element.play())).catch((cause: unknown) => {
      flight('song-play-error', { message: errorText(cause) });
      playingRef.current = false;
      setIsPlaying(false);
      setError(t('playback.audio.loadError', { error: errorText(cause) }));
    });
  }, []);

  const play = useCallback(() => {
    if (!playingRef.current) {
      start('song-play');
    }
  }, [start]);

  const resume = useCallback(() => start('song-resume'), [start]);

  const pause = useCallback(() => {
    const stems = stemsRef.current;
    playingRef.current = false;
    stems?.instrumental.pause();
    stems?.vocals?.pause();
    setIsPlaying(false);
    flight('song-pause', { timeSec: Math.round(stems?.instrumental.currentTime ?? 0) });
  }, []);

  const seek = useCallback(
    (time: number) => {
      const stems = stemsRef.current;
      if (stems === null) {
        return;
      }
      const target = Math.max(0, Math.min(time, stems.instrumental.duration || time));
      stems.instrumental.currentTime = target;
      if (stems.vocals !== null) {
        stems.vocals.currentTime = target;
      }
      notifySubscribers(target);
      setIsFinished(false);
    },
    [notifySubscribers],
  );

  const setGuideVolume = useCallback((value: number) => {
    const clamped = unit(value);
    setGuideVolumeState(clamped);
    const stems = stemsRef.current;
    if (stems !== null) {
      stems.guide.gain.value = clamped;
    }
  }, []);

  const cleanup = useCallback(() => {
    playingRef.current = false;
    stemsRef.current?.release();
    stemsRef.current = null;
  }, []);

  return useMemo(
    () => ({
      getCurrentTime,
      subscribe,
      duration,
      isReady,
      isPlaying,
      isFinished,
      error,
      guideVolume,
      guideAvailable,
      play,
      pause,
      resume,
      seek,
      setGuideVolume,
      cleanup,
      getVocalsBuffer,
      getScoringBuffer,
      getAudioContext,
    }),
    [
      getCurrentTime,
      subscribe,
      duration,
      isReady,
      isPlaying,
      isFinished,
      error,
      guideVolume,
      guideAvailable,
      play,
      pause,
      resume,
      seek,
      setGuideVolume,
      cleanup,
      getVocalsBuffer,
      getScoringBuffer,
      getAudioContext,
    ],
  );
}
