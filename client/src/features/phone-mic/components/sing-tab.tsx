import { EndedPanel } from '@/features/phone-mic/components/ended-panel';
import { JoinPanel } from '@/features/phone-mic/components/join-panel';
import { LivePanel } from '@/features/phone-mic/components/live-panel';
import { LyricCard } from '@/features/phone-mic/components/lyric-card';
import { MixControls } from '@/features/phone-mic/components/mix-controls';
import { NextUpCard } from '@/features/phone-mic/components/next-up-card';
import { problemMessage } from '@/features/phone-mic/components/problem-message';
import { SongRemote } from '@/features/phone-mic/components/song-remote';
import { TuneMic } from '@/features/phone-mic/components/tune-mic';
import { VoiceGuidance } from '@/features/phone-mic/components/voice-guidance';
import type { PhoneMicApp } from '@/features/phone-mic/lib/app';
import type { PartyState } from '@/features/phone-mic/lib/party-state';
import { myItems, singsCurrent } from '@/features/phone-mic/lib/party-view';
import type { PhoneMicSnapshot } from '@/features/phone-mic/lib/session';
import type { MicSlot } from '@/features/remote-mic/protocol';
import { formatNumber, t } from '@/i18n';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';

type SingTabProps = {
  app: PhoneMicApp;
  mic: PhoneMicSnapshot;
  party: PartyState;
  slot: MicSlot | null;
  /** The socket is down: party controls wait for "Reconnecting…". */
  offline: boolean;
};

/** Guests wait for a mic and this phone has no song coming: offer to hand the mic on. */
function PassMicCard({ app, party, slot }: Pick<SingTabProps, 'app' | 'party' | 'slot'>) {
  const waiting = party.snapshot?.waiting ?? 0;
  if (
    waiting === 0 ||
    singsCurrent(party.snapshot, slot) ||
    myItems(party.snapshot, slot).length > 0
  ) {
    return null;
  }
  return (
    <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
      <p className="text-base font-semibold">
        {t('phoneMic.pass.waiting', { count: formatNumber(waiting) })}
      </p>
      <p className="text-sm text-muted-foreground">{t('phoneMic.pass.hint')}</p>
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="h-12 text-base"
        onClick={() => app.session.leave()}
      >
        {t('phoneMic.pass.action')}
      </Button>
    </section>
  );
}

function JoinedSing({ app, mic, party, slot, offline }: SingTabProps) {
  const singing = singsCurrent(party.snapshot, slot);

  return (
    <div className="flex flex-col gap-5">
      <PassMicCard app={app} party={party} slot={slot} />
      <VoiceGuidance mic={mic} onRetry={() => app.session.retryVoice()} />
      {singing && party.lyric !== null ? <LyricCard lyric={party.lyric} /> : null}
      {singing ? <SongRemote party={party} controller={app.party} disabled={offline} /> : null}
      <NextUpCard party={party} controller={app.party} slot={slot} disabled={offline} />
      <LivePanel
        snapshot={mic}
        slot={slot}
        readLevel={app.readLevel}
        onToggleMute={() => app.session.toggleMute()}
        onTapToResume={() => app.session.tapToResume()}
      />
      <MixControls party={party} controller={app.party} slot={slot} disabled={offline} />
      <TuneMic party={party} controller={app.party} disabled={offline} />
      <Button
        type="button"
        variant="ghost"
        size="lg"
        className="h-12 self-center px-6 text-base"
        onClick={() => app.session.leave()}
      >
        {t('phoneMic.actions.leave')}
      </Button>
    </div>
  );
}

/** All mics are taken: the phone keeps asking for one; no mic controls until it has one. */
function WaitingForMic({ app, mic }: { app: PhoneMicApp; mic: PhoneMicSnapshot }) {
  return (
    <div className="flex flex-col gap-5">
      <Alert>
        <AlertDescription className="flex flex-col gap-2 text-base">
          <span>{problemMessage('slots-full')}</span>
          {mic.linePosition === null ? null : (
            <span className="font-semibold">
              {t('phoneMic.wait.position', { position: formatNumber(mic.linePosition) })}
            </span>
          )}
          <span className="text-sm text-muted-foreground">{t('phoneMic.wait.how')}</span>
        </AlertDescription>
      </Alert>
      <Button
        type="button"
        variant="ghost"
        size="lg"
        className="h-12 self-center px-6 text-base"
        onClick={() => app.session.leave()}
      >
        {t('phoneMic.actions.leave')}
      </Button>
    </div>
  );
}

/** Sing: the join card, then the mic, the singer's remote and the mic's settings. */
export function SingTab(props: SingTabProps) {
  const { app, mic } = props;
  if (mic.stage === 'joined' && mic.problem === 'slots-full') {
    return <WaitingForMic app={app} mic={mic} />;
  }
  if (mic.stage === 'joined') {
    return <JoinedSing {...props} />;
  }
  if (mic.stage === 'ended') {
    return <EndedPanel problem={mic.problem} onRejoin={() => app.session.rejoin()} />;
  }
  return (
    <JoinPanel
      slot={app.session.requestedSlot}
      starting={mic.stage === 'starting'}
      problem={mic.problem}
      defaultName={app.session.singerName}
      onJoin={(name) => app.session.join(name)}
    />
  );
}
