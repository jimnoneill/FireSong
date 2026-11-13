import { MicIcon } from 'lucide-react';

import { playerColorOption, type PlayerColor } from '@/shared/player-colors';
import { cn } from '@/shared/utils/cn';

type SlotDiscProps = {
  color: PlayerColor | null;
  size: 'sm' | 'lg';
};

/** The slot's player colour, matching the QR code and the TV badge. */
export function SlotDisc({ color, size }: SlotDiscProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full text-neutral-950',
        color === null ? 'bg-muted text-foreground' : playerColorOption(color).className,
        size === 'lg' ? 'size-24' : 'size-12',
      )}
    >
      <MicIcon className={size === 'lg' ? 'size-10' : 'size-6'} />
    </span>
  );
}
