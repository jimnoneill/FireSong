import { formatKey, formatTempo } from '@/features/phone-mic/components/format';
import { Stepper } from '@/features/phone-mic/components/stepper';
import type { ShiftValues } from '@/features/phone-mic/lib/party-state';
import {
  MAX_KEY_OFFSET,
  MAX_TEMPO,
  MIN_KEY_OFFSET,
  MIN_TEMPO,
  TEMPO_STEP,
} from '@/features/remote-mic/protocol';
import { t } from '@/i18n';

/** Tempo ratios stay on the 0.1 grid, so repeated steps never drift off it. */
const roundTempo = (tempo: number): number =>
  Number((Math.round(tempo / TEMPO_STEP) * TEMPO_STEP).toFixed(1));

type KeyTempoSteppersProps = {
  values: ShiftValues;
  onChange: (values: ShiftValues) => void;
  disabled: boolean;
};

export function KeyTempoSteppers({ values, onChange, disabled }: KeyTempoSteppersProps) {
  return (
    <div className="flex flex-col gap-2">
      <Stepper
        label={t('phoneMic.remote.key')}
        value={values.keyOffset}
        format={formatKey}
        step={1}
        canDecrease={values.keyOffset > MIN_KEY_OFFSET}
        canIncrease={values.keyOffset < MAX_KEY_OFFSET}
        disabled={disabled}
        onChange={(keyOffset) => onChange({ ...values, keyOffset })}
      />
      <Stepper
        label={t('phoneMic.remote.tempo')}
        value={values.tempo}
        format={formatTempo}
        step={TEMPO_STEP}
        canDecrease={values.tempo > MIN_TEMPO + TEMPO_STEP / 2}
        canIncrease={values.tempo < MAX_TEMPO - TEMPO_STEP / 2}
        disabled={disabled}
        onChange={(tempo) => onChange({ ...values, tempo: roundTempo(tempo) })}
      />
    </div>
  );
}
