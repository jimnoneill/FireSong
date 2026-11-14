import { useId } from 'react';

import { formatPercent } from '@/features/phone-mic/components/format';
import type { PartyController } from '@/features/phone-mic/lib/party-controller';
import type { PartyState } from '@/features/phone-mic/lib/party-state';
import { mixSettings } from '@/features/phone-mic/lib/party-view';
import { MAX_ECHO_PCT, MAX_VOLUME_PCT, type MicSlot } from '@/features/remote-mic/protocol';
import { t } from '@/i18n';

const MIX_STEP = 5;

type RangeFieldProps = {
  label: string;
  value: number;
  max: number;
  disabled: boolean;
  onChange: (value: number) => void;
};

function RangeField({ label, value, max, disabled, onChange }: RangeFieldProps) {
  const id = useId();

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-base">
          {label}
        </label>
        <output htmlFor={id} className="text-sm font-medium tabular-nums">
          {formatPercent(value)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={max}
        step={MIX_STEP}
        value={value}
        disabled={disabled}
        aria-valuetext={formatPercent(value)}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-11 w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
      />
    </div>
  );
}

type MixControlsProps = {
  party: PartyState;
  controller: PartyController;
  slot: MicSlot | null;
  disabled: boolean;
};

/** This slot's fader and echo on the TV; 100 % is the room's normal sound. */
export function MixControls({ party, controller, slot, disabled }: MixControlsProps) {
  const mix = mixSettings(party, slot);

  return (
    <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
      <RangeField
        label={t('phoneMic.mix.volume')}
        value={mix.volumePct}
        max={MAX_VOLUME_PCT}
        disabled={disabled}
        onChange={(volumePct) => controller.mix({ volumePct })}
      />
      <RangeField
        label={t('phoneMic.mix.echo')}
        value={mix.echoPct}
        max={MAX_ECHO_PCT}
        disabled={disabled}
        onChange={(echoPct) => controller.mix({ echoPct })}
      />
    </section>
  );
}
