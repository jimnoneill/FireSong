import { useEffect, useState } from 'react';

import { createLazyRevealSounds, type RevealSounds } from './audio/reveal-synth';
import { revealSoundOutput } from './audio/sound-output';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(REDUCED_MOTION_QUERY).matches;

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return reduced;
}

/** Reveal sounds for one results screen; everything still sounding stops on unmount. */
export function useRevealSounds(): RevealSounds {
  const [sounds] = useState(() => createLazyRevealSounds(revealSoundOutput));

  useEffect(() => () => sounds.stop(), [sounds]);

  return sounds;
}
