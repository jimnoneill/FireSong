import { useId } from 'react';

import { SheetDialog } from '@/features/phone-mic/components/sheet-dialog';
import { t } from '@/i18n';
import { Button } from '@/shared/components/ui/button';

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();

  return (
    <SheetDialog open={open} onClose={onCancel} labelledBy={titleId} placement="center">
      <h2 id={titleId} className="text-xl font-semibold">
        {title}
      </h2>
      <p className="mt-2 text-base text-muted-foreground">{body}</p>
      <div className="mt-5 grid grid-cols-2 gap-3">
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="h-12 text-base"
          onClick={onCancel}
        >
          {t('common.actions.cancel')}
        </Button>
        <Button
          type="button"
          variant={destructive ? 'destructive' : 'default'}
          size="lg"
          className="h-12 text-base"
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </SheetDialog>
  );
}
