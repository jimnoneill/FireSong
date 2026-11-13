import { memo, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { clampPlaybackScale } from '@/features/playback/lib/display-scale';
import {
  usePlaybackTransportActions,
  usePlaybackTransportState,
} from '@/features/playback/providers';
import { splitLongSegments } from '@/features/playback/utils/transcript-segments';
import { cn } from '@/shared/utils/cn';
import type { AppConfig } from '@/types/AppConfig';
import type { Segment, Word } from '@/types/Transcript';

import {
  COUNTDOWN_DOTS,
  MAX_WORDS_PER_LINE,
  twoLineState,
  verseStarts,
  wipeClipPath,
  wordWipeProgress,
  type TwoLineState,
} from '../lyric-layout';

type LyricsRomanizationMode = NonNullable<AppConfig['lyrics_romanization_mode']>;

type Props = {
  segments: Segment[];
  title: string;
  artist: string;
  scale?: number | null;
  romanizationMode: LyricsRomanizationMode;
};

const OUTLINE =
  '[paint-order:stroke_fill] [-webkit-text-stroke:0.1em_rgb(0_0_0/0.85)] [text-shadow:0_0.04em_0.12em_rgb(0_0_0/0.8)]';
const BASE_TEXT = cn('text-white', OUTLINE);
const WIPE_TEXT = cn('absolute inset-0 text-sky-300', OUTLINE);
const DOT_KEYS = ['dot-1', 'dot-2', 'dot-3', 'dot-4'] as const;
const HIDDEN_CLIP = wipeClipPath(0);

type OverlayRefs = Map<string, HTMLSpanElement>;

const wordKey = (line: number, index: number): string => `${line}:${index}`;

const sameLayout = (left: TwoLineState, right: TwoLineState): boolean =>
  left.top === right.top &&
  left.bottom === right.bottom &&
  left.countdownDots === right.countdownDots &&
  left.intro === right.intro;

function WordContent({ word, reading }: { word: Word; reading: boolean }) {
  if (!reading) {
    return word.word;
  }
  return (
    <span className="inline-flex flex-col items-center leading-tight">
      <span className="text-[0.42em] font-semibold">{word.reading ?? ' '}</span>
      <span>{word.word}</span>
    </span>
  );
}

function LyricWord({
  word,
  reading,
  overlayRef,
}: {
  word: Word;
  reading: boolean;
  overlayRef: (element: HTMLSpanElement | null) => void;
}) {
  return (
    <span className="relative inline-block whitespace-pre">
      <span className={BASE_TEXT}>
        <WordContent word={word} reading={reading} />
      </span>
      <span
        ref={overlayRef}
        aria-hidden="true"
        className={WIPE_TEXT}
        style={{ clipPath: HIDDEN_CLIP }}
      >
        <WordContent word={word} reading={reading} />
      </span>
    </span>
  );
}

function LyricLine({
  segments,
  index,
  align,
  reading,
  overlays,
}: {
  segments: readonly Segment[];
  index: number | null;
  align: 'start' | 'end';
  reading: boolean;
  overlays: RefObject<OverlayRefs>;
}) {
  const segment = index === null ? undefined : segments[index];
  return (
    <p
      className={cn(
        'flex min-h-[1.3em] max-w-full flex-wrap items-end gap-x-[0.32em] leading-tight font-black',
        align === 'start' ? 'self-start' : 'self-end',
      )}
    >
      {segment?.words.map((word, wordIndex) => {
        const key = wordKey(index ?? -1, wordIndex);
        return (
          <LyricWord
            key={`${word.start}-${word.end}-${word.word}`}
            word={word}
            reading={reading && typeof word.reading === 'string' && word.reading !== ''}
            overlayRef={(element) => {
              if (element === null) {
                overlays.current.delete(key);
                return;
              }
              overlays.current.set(key, element);
            }}
          />
        );
      })}
    </p>
  );
}

function CountdownDots({ lit }: { lit: number }) {
  return (
    <div aria-hidden="true" className="flex gap-[1.2vh] self-start">
      {DOT_KEYS.map((key, index) => (
        <span
          key={key}
          className={cn(
            'size-[2.2vh] rounded-full border-2 border-black/70',
            index < lit ? 'bg-amber-300' : 'bg-white/20',
          )}
        />
      ))}
    </div>
  );
}

function TitleCard({ title, artist }: { title: string; artist: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[30vh] z-10 flex flex-col items-center gap-[1.5vh] px-[6vw] text-center">
      <p className={cn('text-[8vh] leading-tight font-black', BASE_TEXT)}>{title}</p>
      <p className={cn('text-[4vh] font-bold', BASE_TEXT)}>{artist}</p>
    </div>
  );
}

function applyWipes(
  overlays: OverlayRefs,
  segments: readonly Segment[],
  lines: readonly (number | null)[],
  time: number,
) {
  for (const line of lines) {
    if (line === null) {
      continue;
    }
    segments[line].words.forEach((word, wordIndex) => {
      const overlay = overlays.get(wordKey(line, wordIndex));
      if (overlay !== undefined) {
        overlay.style.clipPath = wipeClipPath(wordWipeProgress(word, time));
      }
    });
  }
}

function useLyricClock(lines: readonly Segment[], starts: readonly number[]) {
  const { isPlaying, paused } = usePlaybackTransportState();
  const { subscribe, getCurrentTime } = usePlaybackTransportActions();
  const [layout, setLayout] = useState(() => twoLineState(lines, starts, getCurrentTime()));
  const layoutRef = useRef(layout);
  const overlaysRef = useRef<OverlayRefs>(new Map());
  const animate = isPlaying && !paused;

  useLayoutEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useLayoutEffect(() => {
    const apply = (time: number) => {
      const next = twoLineState(lines, starts, time);
      if (!sameLayout(next, layoutRef.current)) {
        layoutRef.current = next;
        setLayout(next);
      }
      applyWipes(overlaysRef.current, lines, [next.top, next.bottom], time);
    };

    apply(getCurrentTime());
    if (!animate) {
      return subscribe(apply);
    }
    let raf = 0;
    const loop = () => {
      apply(getCurrentTime());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [animate, getCurrentTime, lines, starts, subscribe]);

  // Newly rendered lines get their wipe before they are painted.
  useLayoutEffect(() => {
    applyWipes(overlaysRef.current, lines, [layout.top, layout.bottom], getCurrentTime());
  }, [getCurrentTime, layout, lines]);

  return { layout, overlays: overlaysRef };
}

function NoraebangLyricsImpl({ segments, title, artist, scale, romanizationMode }: Props) {
  const lines = useMemo(() => splitLongSegments(segments, MAX_WORDS_PER_LINE), [segments]);
  const starts = useMemo(() => verseStarts(lines), [lines]);
  const { layout, overlays } = useLyricClock(lines, starts);
  const fontSize = `${5.6 * clampPlaybackScale(scale)}vh`;
  const reading = romanizationMode !== 'disabled';
  const visible = layout.top !== null || layout.bottom !== null;

  return (
    <>
      {layout.intro && <TitleCard title={title} artist={artist} />}
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 bottom-[7vh] z-10 flex flex-col gap-[1.6vh] px-[6vw]',
          !visible && 'invisible',
        )}
        style={{ fontSize }}
      >
        {layout.countdownDots > 0 && (
          <CountdownDots lit={Math.min(COUNTDOWN_DOTS, layout.countdownDots)} />
        )}
        <LyricLine
          segments={lines}
          index={layout.top}
          align="start"
          reading={reading}
          overlays={overlays}
        />
        <LyricLine
          segments={lines}
          index={layout.bottom}
          align="end"
          reading={reading}
          overlays={overlays}
        />
      </div>
    </>
  );
}

/**
 * Noraebang lyric bar: two equal lines at the bottom, each word wiping from
 * white to colour over its own timing, with a four-dot countdown before each
 * verse and a title card over the intro.
 */
export const NoraebangLyrics = memo(NoraebangLyricsImpl);
