import { AudioLinesIcon } from 'lucide-react';

import { calibrationFailureText } from '@/features/phone-mic/components/format';
import { useNow } from '@/features/phone-mic/hooks/use-now';
import type { PartyController } from '@/features/phone-mic/lib/party-controller';
import {
  CALIBRATE_COOLDOWN_MS,
  type CalibrationView,
  type PartyState,
} from '@/features/phone-mic/lib/party-state';
import { calibrateCooldownUntil } from '@/features/phone-mic/lib/party-view';
import { formatNumber, t } from '@/i18n';
import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/utils/cn';

const statusText = (calibration: CalibrationView): string | null => {
  switch (calibration.state) {
    case 'idle':
      return null;
    case 'requested':
    case 'started':
      return t('phoneMic.tune.listening');
    case 'done':
      return calibration.latencyMs === undefined
        ? t('phoneMic.tune.doneNoValue')
        : t('phoneMic.tune.done', { ms: formatNumber(calibration.latencyMs) });
    case 'failed':
      return calibrationFailureText(calibration.reason);
  }
  calibration satisfies never;
  return null;
};

const unavailableText = (party: PartyState): string | null => {
  const snapshot = party.snapshot;
  if (snapshot === null) {
    return null;
  }
  if (!snapshot.tvConnected) {
    return t('phoneMic.failure.noTv');
  }
  return snapshot.stage.state === 'lobby' ? null : t('phoneMic.tune.lobbyOnly');
};

type TuneMicProps = {
  party: PartyState;
  controller: PartyController;
  disabled: boolean;
};

type TuneStatusProps = {
  calibration: CalibrationView;
  running: boolean;
  cooldownUntil: number | null;
  now: number;
};

function TuneStatus({ calibration, running, cooldownUntil, now }: TuneStatusProps) {
  const status = statusText(calibration);
  const cooling = cooldownUntil !== null && !running;

  return (
    <div aria-live="polite" className="flex flex-col gap-2">
      {running ? (
        <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
        </div>
      ) : null}
      {status === null ? null : (
        <p
          data-testid="tune-status"
          className={cn('text-base', calibration.state === 'failed' ? 'text-destructive' : '')}
        >
          {status}
        </p>
      )}
      {cooling ? (
        <p className="text-sm text-muted-foreground">
          {t('phoneMic.tune.again', {
            secs: formatNumber(Math.max(1, Math.ceil((cooldownUntil - now) / 1_000))),
          })}
        </p>
      ) : null}
    </div>
  );
}

/** "Tune my mic": the TV beeps and measures this phone's delay, between songs only. */
export function TuneMic({ party, controller, disabled }: TuneMicProps) {
  const running = party.calibration.state === 'requested' || party.calibration.state === 'started';
  const now = useNow(
    party.calibrateSentAt === null ? null : party.calibrateSentAt + CALIBRATE_COOLDOWN_MS,
  );
  const cooldownUntil = calibrateCooldownUntil(party, now);
  const unavailable = unavailableText(party);

  return (
    <section
      aria-labelledby="phone-tune-title"
      className="flex flex-col gap-3 rounded-2xl border bg-card p-4"
    >
      <h2 id="phone-tune-title" className="sr-only">
        {t('phoneMic.tune.action')}
      </h2>
      <p className="text-sm text-muted-foreground">{unavailable ?? t('phoneMic.tune.hint')}</p>
      <Button
        type="button"
        variant="secondary"
        size="lg"
        className="h-12 text-base"
        disabled={disabled || running || unavailable !== null || cooldownUntil !== null}
        onClick={() => controller.calibrate()}
      >
        <AudioLinesIcon className="size-5" />
        {t('phoneMic.tune.action')}
      </Button>
      <TuneStatus
        calibration={party.calibration}
        running={running}
        cooldownUntil={cooldownUntil}
        now={now}
      />
    </section>
  );
}
