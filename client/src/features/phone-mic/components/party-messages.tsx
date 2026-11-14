import { XIcon } from 'lucide-react';

import { messageText } from '@/features/phone-mic/components/format';
import type { PartyController } from '@/features/phone-mic/lib/party-controller';
import type { PartyState } from '@/features/phone-mic/lib/party-state';
import { t } from '@/i18n';
import { cn } from '@/shared/utils/cn';

/** Notices about this phone's songs and requests that did not go through, just above the tabs. */
export function PartyMessages({
  party,
  controller,
}: {
  party: PartyState;
  controller: PartyController;
}) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none mx-auto flex w-full max-w-md flex-col gap-2 px-4"
    >
      {party.messages.map((message) => (
        <div
          key={message.id}
          data-testid="party-message"
          className={cn(
            'pointer-events-auto flex items-start gap-2 rounded-xl border px-3 py-2 text-sm shadow-lg',
            message.kind === 'failure'
              ? 'border-destructive/40 bg-card text-destructive'
              : 'bg-card',
          )}
        >
          <p className="min-w-0 flex-1 py-1">{messageText(message, party.snapshot)}</p>
          <button
            type="button"
            aria-label={t('common.actions.close')}
            onClick={() => controller.dismiss(message.id)}
            className="-m-1 flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon aria-hidden="true" className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
