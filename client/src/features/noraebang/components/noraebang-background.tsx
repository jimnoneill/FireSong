import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type SyntheticEvent,
} from 'react';

import { Background } from '@/features/playback/components/background';
import { themeKey } from '@/features/playback/components/theme';
import { VIDEO_CLASS_NAME } from '@/features/playback/lib/video-styles';
import { usePlaybackStartupActions } from '@/features/playback/providers/playback-startup-context';
import { usePlaybackThemeState } from '@/features/playback/providers/playback-theme-context';
import { usePlaybackTransportState } from '@/features/playback/providers/playback-transport-context';
import { t, useTranslation } from '@/i18n';
import { cn } from '@/shared/utils/cn';

import { LICENSE_LABELS } from '../captions';
import { nextNoraebangClip, useNoraebangClipPool, type PlayableClip } from '../clip-pool';

/** Length of the crossfade between two clips, ms. */
const CROSSFADE_MS = 1200;
/** Give up on the clip pool if the first clip cannot play within this, ms. */
const FIRST_CLIP_TIMEOUT_MS = 8000;

type Layer = 0 | 1;
type Layers = readonly [PlayableClip | null, PlayableClip | null];

const otherLayer = (layer: Layer): Layer => (layer === 0 ? 1 : 0);

function safePlay(video: HTMLVideoElement | null): void {
  // Autoplay refusals leave the clip paused; the next crossfade tries again.
  void video?.play().catch(() => {});
}

function clipCredit(clip: PlayableClip): string {
  return [clip.title, clip.author, t(LICENSE_LABELS[clip.license])]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' · ');
}

function useFirstClipReady(onFail: () => void) {
  const { theme } = usePlaybackThemeState();
  const { markBackgroundReady } = usePlaybackStartupActions();
  const activeThemeKey = themeKey(theme);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (ready) {
      markBackgroundReady(activeThemeKey);
      return undefined;
    }
    const timer = window.setTimeout(onFail, FIRST_CLIP_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [activeThemeKey, markBackgroundReady, onFail, ready]);

  return { ready, markReady: useCallback(() => setReady(true), []) };
}

type ClipVideoProps = {
  layer: Layer;
  clip: PlayableClip | null;
  isFront: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  onCanPlay?: () => void;
  onNearEnd: (layer: Layer) => void;
  onEnded: (layer: Layer) => void;
  onError: (layer: Layer) => void;
};

function ClipVideo({
  layer,
  clip,
  isFront,
  videoRef,
  onCanPlay,
  onNearEnd,
  onEnded,
  onError,
}: ClipVideoProps) {
  const onTimeUpdate = (event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    const remainingMs = (video.duration - video.currentTime) * 1000;
    if (Number.isFinite(remainingMs) && remainingMs <= CROSSFADE_MS) {
      onNearEnd(layer);
    }
  };

  return (
    <video
      ref={videoRef}
      data-testid={`noraebang-clip-${layer}`}
      className={cn(
        VIDEO_CLASS_NAME,
        'transition-opacity duration-1200 ease-in-out motion-reduce:transition-none',
        isFront ? 'opacity-100' : 'opacity-0',
      )}
      src={clip?.url}
      preload="auto"
      muted
      playsInline
      onCanPlay={isFront ? onCanPlay : undefined}
      onTimeUpdate={onTimeUpdate}
      onEnded={() => onEnded(layer)}
      onError={() => onError(layer)}
    />
  );
}

type CrossfaderProps = {
  clips: readonly PlayableClip[];
  onFail: () => void;
};

/** Two stacked videos: the front one plays, the back one preloads the next clip. */
function ClipCrossfader({ clips, onFail }: CrossfaderProps) {
  useTranslation();
  const { isPlaying } = usePlaybackTransportState();
  const { ready, markReady } = useFirstClipReady(onFail);
  const firstRef = useRef<HTMLVideoElement>(null);
  const secondRef = useRef<HTMLVideoElement>(null);
  // A random pick per song is this component's initial state.
  const [layers, setLayers] = useState<Layers>(() => [
    nextNoraebangClip(clips),
    nextNoraebangClip(clips),
  ]);
  const [front, setFront] = useState<Layer>(0);
  const fadeTimerRef = useRef<number | null>(null);
  const videoOf = useCallback((layer: Layer) => (layer === 0 ? firstRef : secondRef).current, []);

  useEffect(() => {
    const video = videoOf(front);
    if (isPlaying && ready) {
      safePlay(video);
    } else {
      video?.pause();
    }
  }, [front, isPlaying, ready, videoOf]);

  useEffect(
    () => () => {
      if (fadeTimerRef.current !== null) {
        window.clearTimeout(fadeTimerRef.current);
      }
    },
    [],
  );

  const crossfade = useCallback(
    (from: Layer) => {
      if (from !== front || fadeTimerRef.current !== null) {
        return;
      }
      const to = otherLayer(from);
      const next = videoOf(to);
      if (next !== null) {
        next.currentTime = 0;
        if (isPlaying) {
          safePlay(next);
        }
      }
      setFront(to);
      fadeTimerRef.current = window.setTimeout(() => {
        fadeTimerRef.current = null;
        const clip = nextNoraebangClip(clips);
        setLayers((current) => (from === 0 ? [clip, current[1]] : [current[0], clip]));
      }, CROSSFADE_MS);
    },
    [clips, front, isPlaying, videoOf],
  );

  const handleError = (layer: Layer) => {
    if (layer === front && !ready) {
      onFail();
      return;
    }
    if (layer === front) {
      crossfade(layer);
      return;
    }
    // A broken preload is replaced before it is ever shown.
    const clip = nextNoraebangClip(clips);
    setLayers((current) => (layer === 0 ? [clip, current[1]] : [current[0], clip]));
  };

  const frontClip = layers[front];
  const shared = {
    onNearEnd: crossfade,
    onEnded: crossfade,
    onError: handleError,
    onCanPlay: markReady,
  };

  return (
    <div className="fixed inset-0 bg-black">
      <ClipVideo layer={0} clip={layers[0]} isFront={front === 0} videoRef={firstRef} {...shared} />
      <ClipVideo
        layer={1}
        clip={layers[1]}
        isFront={front === 1}
        videoRef={secondRef}
        {...shared}
      />
      {frontClip !== null && (
        <p className="pointer-events-none absolute right-[2vw] bottom-[1.5vh] z-10 max-w-[40vw] truncate text-[1.4vh] text-white/40">
          {t('firesong.noraebang.clip.credit', { credit: clipCredit(frontClip) })}
        </p>
      )}
    </div>
  );
}

function NoraebangBackgroundImpl() {
  const pool = useNoraebangClipPool();
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);

  if (pool.isLoading) {
    return <div className="fixed inset-0 bg-black" />;
  }
  if (failed || pool.data === undefined || pool.data.length === 0) {
    return <Background />;
  }
  return <ClipCrossfader clips={pool.data} onFail={fail} />;
}

/**
 * Noraebang background: random license-safe stock clips that crossfade into
 * each other. With no usable clip it falls back to the normal background.
 */
export const NoraebangBackground = memo(NoraebangBackgroundImpl);
