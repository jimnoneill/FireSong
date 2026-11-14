import { MIC_MASCOT_URL } from '@/shared/firesong-brand';
import { playerColorOption, type PlayerColor } from '@/shared/player-colors';
import { cn } from '@/shared/utils/cn';

type SlotDiscProps = {
  color: PlayerColor | null;
  size: 'sm' | 'lg';
};

/** The mic mascot in a ring of the slot's player colour, matching the QR code and the TV badge. */
export function SlotDisc({ color, size }: SlotDiscProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 rounded-full',
        color === null ? 'bg-muted' : playerColorOption(color).className,
        size === 'lg' ? 'size-32 p-1.5' : 'size-14 p-1',
      )}
    >
      <img
        src={MIC_MASCOT_URL}
        alt=""
        className={cn(
          'size-full rounded-full bg-neutral-950 object-contain',
          size === 'lg' ? 'p-2.5' : 'p-1',
        )}
      />
    </span>
  );
}
