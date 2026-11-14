import { useState } from 'react';

import { ConfirmDialog } from '@/features/phone-mic/components/confirm-dialog';
import { KeyTempoSteppers } from '@/features/phone-mic/components/key-tempo-steppers';
import { useNow } from '@/features/phone-mic/hooks/use-now';
import type { PartyController } from '@/features/phone-mic/lib/party-controller';
import type { PartyState, ShiftValues } from '@/features/phone-mic/lib/party-state';
import {
  isPending,
  shiftAllowance,
  type ShiftAllowance,
} from '@/features/phone-mic/lib/party-view';
import { formatNumber, t } from '@/i18n';
import { Button } from '@/shared/components/ui/button';

type KeyTempoEditorProps = {
  party: PartyState;
  controller: PartyController;
  settings: ShiftValues;
  disabled: boolean;
};

const allowanceText = (allowance: ShiftAllowance, now: number): string | null => {
  switch (allowance.kind) {
    case 'ok':
      return null;
    case 'cooldown':
      return t('phoneMic.remote.cooldown', {
        secs: formatNumber(Math.max(1, Math.ceil((allowance.until - now) / 1_000))),
      });
    case 'used-up':
      return t('phoneMic.remote.usedUp');
  }
  allowance satisfies never;
  return null;
};

/** Key and tempo of the song on stage; applying restarts it from the beginning. */
export function KeyTempoEditor({ party, controller, settings, disabled }: KeyTempoEditorProps) {
  const [draft, setDraft] = useState<ShiftValues>(settings);
  const [confirming, setConfirming] = useState(false);
  const pending = isPending(party, 'shift-current');
  const cooling = party.shift !== null;
  const now = useNow(cooling);
  const allowance = shiftAllowance(party, now);
  const changed = draft.keyOffset !== settings.keyOffset || draft.tempo !== settings.tempo;
  const blocked = disabled || pending || allowance.kind !== 'ok';
  const note = pending ? t('phoneMic.remote.changing') : allowanceText(allowance, now);

  return (
    <div className="flex flex-col gap-3">
      <KeyTempoSteppers values={draft} onChange={setDraft} disabled={blocked} />
      {note === null ? null : <p className="text-sm text-muted-foreground">{note}</p>}
      <Button
        type="button"
        variant="secondary"
        size="lg"
        className="h-12 text-base"
        disabled={blocked || !changed}
        onClick={() => setConfirming(true)}
      >
        {t('phoneMic.remote.apply')}
      </Button>
      <ConfirmDialog
        open={confirming}
        title={t('phoneMic.remote.restartConfirm')}
        body={t('phoneMic.remote.restartBody')}
        confirmLabel={t('phoneMic.remote.restart')}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          controller.shiftCurrent(draft);
        }}
      />
    </div>
  );
}
