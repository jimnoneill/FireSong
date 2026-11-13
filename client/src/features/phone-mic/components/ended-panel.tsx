import { problemMessage } from '@/features/phone-mic/components/problem-message';
import type { PhoneMicProblem } from '@/features/phone-mic/lib/session';
import { t } from '@/i18n';
import { Button } from '@/shared/components/ui/button';

type EndedPanelProps = {
  problem: PhoneMicProblem | null;
  onRejoin: () => void;
};

/** Another tab took the slot, the host removed it, or the join was refused: rejoin by hand. */
export function EndedPanel({ problem, onRejoin }: EndedPanelProps) {
  return (
    <section className="flex flex-col items-center gap-6 pt-10 text-center">
      {problem === null ? null : (
        <p role="alert" className="text-lg">
          {problemMessage(problem)}
        </p>
      )}
      <Button type="button" size="lg" className="h-14 w-full text-lg" onClick={onRejoin}>
        {problem === 'replaced' ? t('phoneMic.actions.useThisTab') : t('phoneMic.actions.rejoin')}
      </Button>
    </section>
  );
}
