import { MicIcon, MicOffIcon } from 'lucide-react';

import { LevelMeter } from '@/features/phone-mic/components/level-meter';
import { linkMessage } from '@/features/phone-mic/components/problem-message';
import { SlotDisc } from '@/features/phone-mic/components/slot-disc';
import type { PhoneMicSnapshot } from '@/features/phone-mic/lib/session';
import { slotColor, type MicSlot } from '@/features/remote-mic/protocol';
import { t } from '@/i18n';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { playerColorOption } from '@/shared/player-colors';

type LivePanelProps = {
  snapshot: PhoneMicSnapshot;
  /** The assigned slot, or the QR's slot until the first `assign`. */
  slot: MicSlot | null;
  readLevel: () => number;
  onToggleMute: () => void;
  onTapToResume: () => void;
  onLeave: () => void;
};

/** The phone while it is a mic: who it is, whether the TV hears it, level and mute. */
export function LivePanel({
  snapshot,
  slot,
  readLevel,
  onToggleMute,
  onTapToResume,
  onLeave,
}: LivePanelProps) {
  const color = slot === null ? null : slotColor(slot);
  const title =
    color === null
      ? t('phoneMic.join.any')
      : t('phoneMic.slotLabel', { color: t(playerColorOption(color).label) });

  return (
    <section className="flex flex-col gap-6" aria-labelledby="phone-mic-title">
      <header className="flex items-center gap-3">
        <SlotDisc color={color} size="sm" />
        <div className="min-w-0 flex-1">
          <h1 id="phone-mic-title" className="truncate text-xl font-semibold">
            {title}
          </h1>
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {linkMessage(snapshot.link)}
          </p>
        </div>
      </header>

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

      <Button type="button" variant="ghost" className="self-center" onClick={onLeave}>
        {t('phoneMic.actions.leave')}
      </Button>
    </section>
  );
}
