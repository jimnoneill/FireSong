import { SingerChip } from '@/features/phone-mic/components/singer-chip';
import { MAX_PARTNERS, type MicSlot, type PartySnapshot } from '@/features/remote-mic/protocol';
import { t } from '@/i18n';

type PartnerPickerProps = {
  choices: readonly MicSlot[];
  snapshot: PartySnapshot | null;
  selected: readonly MicSlot[];
  onChange: (selected: readonly MicSlot[]) => void;
};

/** "Duet with…": the other joined phones by name and colour. */
export function PartnerPicker({ choices, snapshot, selected, onChange }: PartnerPickerProps) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-base">{t('phoneMic.reserve.duet')}</legend>
      {choices.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('phoneMic.reserve.partnerNone')}</p>
      ) : null}
      {choices.map((slot) => {
        const checked = selected.includes(slot);
        return (
          <label
            key={slot}
            className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-1"
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={!checked && selected.length >= MAX_PARTNERS}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, slot]
                    : selected.filter((each) => each !== slot),
                )
              }
              className="size-6 shrink-0 accent-primary"
            />
            <SingerChip slot={slot} snapshot={snapshot} className="text-base" />
          </label>
        );
      })}
    </fieldset>
  );
}
