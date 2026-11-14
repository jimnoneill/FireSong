import { slotName } from '@/features/phone-mic/components/format';
import { isMicSlot, slotColor, type PartySnapshot } from '@/features/remote-mic/protocol';
import { playerColorOption } from '@/shared/player-colors';
import { cn } from '@/shared/utils/cn';

type SingerChipProps = {
  slot: number;
  snapshot: PartySnapshot | null;
  /** A name kept from earlier (tonight's best), instead of the slot's current one. */
  name?: string;
  className?: string;
};

/** A singer by name with their slot colour as a dot, so the colour is never the only cue. */
export function SingerChip({ slot, snapshot, name, className }: SingerChipProps) {
  const singer = snapshot?.singers.find((each) => each.slot === slot) ?? null;
  const color = isMicSlot(slot) ? slotColor(slot) : null;

  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <span
        aria-hidden="true"
        className={cn(
          'size-2.5 shrink-0 rounded-full',
          color === null ? 'bg-muted' : playerColorOption(color).className,
        )}
      />
      <span className="truncate">{name ?? slotName(slot, singer)}</span>
    </span>
  );
}
