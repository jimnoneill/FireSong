/**
 * Where reveal sounds play. The TV voice engine registers its long-lived,
 * already-unlocked AudioContext here, so the fanfare goes out with the
 * voices. Without one (an ordinary browser), a context of our own is made
 * on first use and kept for the page's lifetime.
 */

import type { SoundOutput } from './reveal-synth';

export type SoundOutputProvider = () => SoundOutput | null;

let provider: SoundOutputProvider | null = null;
let fallback: SoundOutput | null = null;

/** Called by the TV voice engine. Returns the unregister function. */
export function provideRevealSoundOutput(next: SoundOutputProvider): () => void {
  provider = next;
  return () => {
    if (provider === next) {
      provider = null;
    }
  };
}

function ownOutput(): SoundOutput | null {
  if (fallback !== null) {
    return fallback;
  }
  if (typeof AudioContext === 'undefined') {
    return null;
  }
  try {
    const context = new AudioContext({ latencyHint: 'interactive' });
    fallback = { context, destination: context.destination };
  } catch {
    return null;
  }
  return fallback;
}

const isAudioContext = (context: BaseAudioContext): context is AudioContext =>
  typeof AudioContext !== 'undefined' && context instanceof AudioContext;

/** The output to play reveal sounds on, resumed; `null` when Web Audio is unavailable. */
export function revealSoundOutput(): SoundOutput | null {
  const output = provider?.() ?? ownOutput();
  if (output !== null && isAudioContext(output.context) && output.context.state === 'suspended') {
    // A context that cannot resume stays silent; the reveal itself still runs.
    void output.context.resume().catch(() => {});
  }
  return output;
}
