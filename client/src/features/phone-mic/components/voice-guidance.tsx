import { WifiOffIcon } from 'lucide-react';

import type { PhoneMicSnapshot } from '@/features/phone-mic/lib/session';
import { t } from '@/i18n';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';

type VoiceGuidanceProps = {
  mic: PhoneMicSnapshot;
  onRetry: () => void;
};

/**
 * The voice needs the home Wi-Fi (there is no TURN server): say so instead of
 * spinning, and keep the rest of the page usable over the socket.
 */
export function VoiceGuidance({ mic, onRetry }: VoiceGuidanceProps) {
  if (mic.unreachable) {
    return (
      <Alert variant="destructive" className="gap-2 p-4 text-base" data-testid="voice-unreachable">
        <WifiOffIcon className="size-5" />
        <AlertTitle className="text-base">{t('phoneMic.reach.unreachable')}</AlertTitle>
        <AlertDescription className="flex flex-col gap-3 text-sm">
          {mic.mobileDataHint ? <p>{t('phoneMic.reach.mobileData')}</p> : null}
          <p className="text-muted-foreground">{t('phoneMic.reach.stillWorks')}</p>
          <Button type="button" size="lg" className="h-12 text-base" onClick={onRetry}>
            {t('phoneMic.actions.tryAgain')}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (mic.mobileDataHint && mic.link === 'connecting') {
    return (
      <Alert className="p-4 text-sm" data-testid="voice-mobile-hint">
        <WifiOffIcon className="size-5" />
        <AlertDescription className="text-sm">{t('phoneMic.reach.mobileData')}</AlertDescription>
      </Alert>
    );
  }
  return null;
}
