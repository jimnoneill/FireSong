import { useEffect, useMemo, useState } from 'react';

import { graphemes, litCount, lyricProgress } from '@/features/phone-mic/lib/lyric';
import type { LyricView } from '@/features/phone-mic/lib/party-state';
import { t } from '@/i18n';

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Characters of the line lit at the wall clock, updated per animation frame
 * but re-rendered only when the count changes; static under reduced motion.
 */
const useLitCount = (lyric: LyricView, count: number): number => {
  const [lit, setLit] = useState(0);

  useEffect(() => {
    const still = reducedMotion();
    let frame = 0;
    const step = (): void => {
      const progress = lyricProgress(lyric, Date.now());
      setLit(progress === null || still ? count : litCount(count, progress));
      if (progress !== null && progress < 1 && !lyric.paused && !still) {
        frame = window.requestAnimationFrame(step);
      }
    };
    step();
    return () => window.cancelAnimationFrame(frame);
  }, [lyric, count]);

  return lit;
};

/** While this phone sings: the current line with a colour wipe, and the next line dimmed. */
export function LyricCard({ lyric }: { lyric: LyricView }) {
  const characters = useMemo(() => graphemes(lyric.line), [lyric.line]);
  const lit = useLitCount(lyric, characters.length);

  return (
    <section
      aria-label={t('phoneMic.lyric.label')}
      data-testid="lyric-card"
      data-lit={lit}
      data-chars={characters.length}
      data-paused={lyric.paused}
      className="rounded-2xl border bg-card p-5"
    >
      <p className="text-2xl/snug font-bold break-words">
        <span className="text-primary">{characters.slice(0, lit).join('')}</span>
        <span className="text-foreground/45">{characters.slice(lit).join('')}</span>
      </p>
      {lyric.next === undefined ? null : (
        <p className="mt-3 text-lg/snug break-words text-muted-foreground">{lyric.next}</p>
      )}
    </section>
  );
}
