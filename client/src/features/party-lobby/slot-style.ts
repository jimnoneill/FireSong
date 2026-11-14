import type { PlayerColor } from '@/shared/player-colors';

/** Static Tailwind classes per slot colour, so every class stays visible to the compiler. */
export type SlotStyle = { text: string; border: string; dot: string; ring: string };

export const SLOT_STYLES: Readonly<Record<PlayerColor, SlotStyle>> = {
  rose: {
    text: 'text-rose-300',
    border: 'border-rose-400',
    dot: 'bg-rose-400',
    ring: 'ring-rose-400',
  },
  fuchsia: {
    text: 'text-fuchsia-300',
    border: 'border-fuchsia-400',
    dot: 'bg-fuchsia-400',
    ring: 'ring-fuchsia-400',
  },
  amber: {
    text: 'text-amber-300',
    border: 'border-amber-400',
    dot: 'bg-amber-400',
    ring: 'ring-amber-400',
  },
  emerald: {
    text: 'text-emerald-300',
    border: 'border-emerald-400',
    dot: 'bg-emerald-400',
    ring: 'ring-emerald-400',
  },
};
