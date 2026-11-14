import { MinusIcon, PlusIcon } from 'lucide-react';

import { t } from '@/i18n';
import { Button } from '@/shared/components/ui/button';

type StepperProps = {
  label: string;
  value: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
  canDecrease: boolean;
  canIncrease: boolean;
  step: number;
  disabled?: boolean;
};

/** Key or tempo: minus, the current value, plus; large enough for a thumb. */
export function Stepper({
  label,
  value,
  format,
  onChange,
  canDecrease,
  canIncrease,
  step,
  disabled = false,
}: StepperProps) {
  return (
    <fieldset className="flex items-center gap-3">
      <legend className="sr-only">{label}</legend>
      <span aria-hidden="true" className="min-w-0 flex-1 text-base">
        {label}
      </span>
      <Button
        type="button"
        variant="outline"
        size="icon-lg"
        className="size-11"
        disabled={disabled || !canDecrease}
        aria-label={t('common.actions.decreaseLabel', { label })}
        onClick={() => onChange(value - step)}
      >
        <MinusIcon className="size-5" />
      </Button>
      <output aria-live="polite" className="w-16 text-center text-lg font-semibold tabular-nums">
        {format(value)}
      </output>
      <Button
        type="button"
        variant="outline"
        size="icon-lg"
        className="size-11"
        disabled={disabled || !canIncrease}
        aria-label={t('common.actions.increaseLabel', { label })}
        onClick={() => onChange(value + step)}
      >
        <PlusIcon className="size-5" />
      </Button>
    </fieldset>
  );
}
