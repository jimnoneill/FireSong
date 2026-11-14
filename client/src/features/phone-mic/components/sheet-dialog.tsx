import { useEffect, useRef, type ReactNode } from 'react';

import { cn } from '@/shared/utils/cn';

type SheetDialogProps = {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  /** `sheet` rises from the bottom edge (reachable one-handed); `center` is a confirmation. */
  placement?: 'sheet' | 'center';
  className?: string;
  children: ReactNode;
};

/**
 * A modal on the native `<dialog>`: focus trap, Escape and the inert page
 * behind it come from the browser, so the mic bundle stays small.
 */
export function SheetDialog({
  open,
  onClose,
  labelledBy,
  placement = 'sheet',
  className,
  children,
}: SheetDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      onClose={onClose}
      className={cn(
        'max-h-[85dvh] w-full max-w-md overflow-y-auto bg-card text-card-foreground backdrop:bg-black/60',
        placement === 'sheet'
          ? 'mx-auto mt-auto mb-0 rounded-t-2xl px-5 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]'
          : 'm-auto w-[calc(100%-2.5rem)] rounded-2xl p-5',
        className,
      )}
    >
      {open ? children : null}
    </dialog>
  );
}
