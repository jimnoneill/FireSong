import { MicIcon, MicOffIcon } from 'lucide-react';

import { LevelMeter } from '@/features/phone-mic/components/level-meter';
import type { PhoneMicSnapshot } from '@/features/phone-mic/lib/session';
import { slotColor, type MicSlot } from '@/features/remote-mic/protocol';
import { t } from '@/i18n';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';

type LivePanelProps = {
  snapshot: PhoneMicSnapshot;
  /** The assigned slot, or the QR's slot until the first `assign`. */
  slot: MicSlot | null;
  readLevel: () => number;
  onToggleMute: () => void;
  onTapToResume: () => void;
};

/** The phone while it is a mic: level, mute, and recovery when the system stopped capture. */
export function LivePanel({
  snapshot,
  slot,
  readLevel,
  onToggleMute,
  onTapToResume,
}: LivePanelProps) {
  const color = slot === null ? null : slotColor(slot);

  return (
    <div className="flex flex-col gap-4">
      {snapshot.needsTap ? (
        <div className="flex flex-col gap-2" role="alert">
          <p className="text-sm">{t('phoneMic.needsTap')}</p>
          <Button type="button" size="lg" className="h-14 text-lg" onClick={onTapToResume}>
            {t('phoneMic.actions.tapToRejoin')}
          </Button>
        </div>
      ) : null}

      {snapshot.problem === 'slots-full' ? (
        <Alert>
          <AlertDescription className="text-sm">{t('phoneMic.problem.slotsFull')}</AlertDescription>
        </Alert>
      ) : null}

      <LevelMeter readLevel={readLevel} color={color} muted={snapshot.muted} />

      <Button
        type="button"
        size="lg"
        variant={snapshot.muted ? 'destructive' : 'secondary'}
        className="h-16 text-lg"
        onClick={onToggleMute}
      >
        {snapshot.muted ? <MicOffIcon className="size-6" /> : <MicIcon className="size-6" />}
        {snapshot.muted ? t('phoneMic.actions.unmute') : t('phoneMic.actions.mute')}
      </Button>

      {snapshot.mutedBy === 'tv' ? (
        <p className="text-center text-sm text-muted-foreground">{t('phoneMic.mutedByHost')}</p>
      ) : null}

      {snapshot.wakeLock === 'unavailable' ? (
        <p className="text-center text-sm text-muted-foreground">{t('phoneMic.wakeLockHint')}</p>
      ) : null}
    </div>
  );
}
