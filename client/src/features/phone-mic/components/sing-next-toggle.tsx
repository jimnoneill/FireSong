import { useId } from 'react';

import { t } from '@/i18n';

type SingNextToggleProps = {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
};

/** "Sing next": goes before the songs reserved without it; one per phone. */
export function SingNextToggle({ checked, disabled, onChange }: SingNextToggleProps) {
  const id = useId();
  const hintId = useId();

  return (
    <div className="flex items-center gap-3">
      <label htmlFor={id} className="min-w-0 flex-1 text-base">
        {t('phoneMic.reserve.singNext')}
        {disabled && !checked ? (
          <span id={hintId} className="block text-sm text-muted-foreground">
            {t('phoneMic.reserve.limitSingNext')}
          </span>
        ) : null}
      </label>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled && !checked}
        aria-describedby={disabled && !checked ? hintId : undefined}
        onChange={(event) => onChange(event.target.checked)}
        className="size-7 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed"
      />
    </div>
  );
}
