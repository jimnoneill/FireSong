import { useLayoutEffect, useRef } from 'react';

import { nextMeterLevel } from '@/features/phone-mic/lib/meter-math';
import { t } from '@/i18n';
import { playerColorOption, type PlayerColor } from '@/shared/player-colors';
import { cn } from '@/shared/utils/cn';

/** Screen readers and reduced-motion users get the level a few times a second. */
const SLOW_UPDATE_MS = 250;

type LevelMeterProps = {
  readLevel: () => number;
  color: PlayerColor | null;
  muted: boolean;
};

/**
 * The microphone's input level, written straight to the DOM every frame; the
 * layout effect sets the empty bar before the first paint.
 */
export function LevelMeter({ readLevel, color, muted }: LevelMeterProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const meterRef = useRef<HTMLMeterElement>(null);

  useLayoutEffect(() => {
    const bar = barRef.current;
    const meter = meterRef.current;
    if (bar === null || meter === null) {
      return undefined;
    }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let level = 0;
    let lastFrame = performance.now();
    let lastSlowUpdate = 0;
    let frame = 0;
    bar.style.setProperty('--meter-level', '0');

    const tick = (now: number): void => {
      const target = readLevel();
      level = reducedMotion ? target : nextMeterLevel(level, target, now - lastFrame);
      lastFrame = now;

      const slowDue = now - lastSlowUpdate >= SLOW_UPDATE_MS;
      if (!reducedMotion || slowDue) {
        bar.style.setProperty('--meter-level', level.toFixed(3));
      }
      if (slowDue) {
        lastSlowUpdate = now;
        meter.value = Math.round(level * 100);
      }
      frame = window.requestAnimationFrame(tick);
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [readLevel]);

  return (
    <div>
      <meter
        ref={meterRef}
        className="sr-only"
        min={0}
        max={100}
        aria-label={t('phoneMic.level')}
      />
      <div
        ref={barRef}
        aria-hidden="true"
        className={cn(
          'h-6 w-full overflow-hidden rounded-full bg-muted',
          muted ? 'opacity-40' : 'opacity-100',
        )}
      >
        <div
          className={cn(
            'h-full w-full origin-left scale-x-(--meter-level)',
            color === null ? 'bg-primary' : playerColorOption(color).className,
          )}
        />
      </div>
    </div>
  );
}
