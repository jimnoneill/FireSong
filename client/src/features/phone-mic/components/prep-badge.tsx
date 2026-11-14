import { prepLabel } from '@/features/phone-mic/components/format';
import type { PrepState } from '@/features/remote-mic/protocol';
import { cn } from '@/shared/utils/cn';

const TONE = {
  ready: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'not-ready': 'bg-muted text-muted-foreground',
  queued: 'bg-amber-500/15 text-amber-800 dark:text-amber-200',
  analyzing: 'bg-amber-500/15 text-amber-800 dark:text-amber-200',
  'waiting-gpu': 'bg-muted text-muted-foreground',
  failed: 'bg-destructive/15 text-destructive',
} satisfies Record<PrepState['state'], string>;

/** How far a song is from being singable, as words (the tint only repeats it). */
export function PrepBadge({ prep }: { prep: PrepState }) {
  return (
    <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs font-medium', TONE[prep.state])}>
      {prepLabel(prep)}
    </span>
  );
}
