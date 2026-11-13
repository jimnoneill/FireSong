import { EndedPanel } from '@/features/phone-mic/components/ended-panel';
import { JoinPanel } from '@/features/phone-mic/components/join-panel';
import { LivePanel } from '@/features/phone-mic/components/live-panel';
import { SongResultCard } from '@/features/phone-mic/components/song-result-card';
import { usePhoneMicSnapshot } from '@/features/phone-mic/hooks/use-phone-mic-snapshot';
import type { PhoneMicSession, PhoneMicSnapshot } from '@/features/phone-mic/lib/session';
import { useTranslation } from '@/i18n';

type PhoneMicPageProps = {
  session: PhoneMicSession;
  readLevel: () => number;
};

type StagePanelProps = PhoneMicPageProps & { snapshot: PhoneMicSnapshot };

function StagePanel({ session, readLevel, snapshot }: StagePanelProps) {
  if (snapshot.stage === 'joined') {
    return (
      <LivePanel
        snapshot={snapshot}
        slot={snapshot.slot ?? session.requestedSlot}
        readLevel={readLevel}
        onToggleMute={() => session.toggleMute()}
        onTapToResume={() => session.tapToResume()}
        onLeave={() => session.leave()}
      />
    );
  }
  if (snapshot.stage === 'ended') {
    return <EndedPanel problem={snapshot.problem} onRejoin={() => session.rejoin()} />;
  }
  return (
    <JoinPanel
      slot={session.requestedSlot}
      starting={snapshot.stage === 'starting'}
      problem={snapshot.problem}
      defaultName={session.singerName}
      onJoin={(name) => session.join(name)}
    />
  );
}

/** `/m`: a guest's phone as one of the four wireless mics. */
export function PhoneMicPage({ session, readLevel }: PhoneMicPageProps) {
  useTranslation();
  const snapshot = usePhoneMicSnapshot(session);

  return (
    <main className="h-dvh overflow-y-auto">
      <div className="mx-auto flex max-w-md flex-col gap-6 px-5 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        {snapshot.result === null ? null : (
          <SongResultCard result={snapshot.result} onDismiss={() => session.dismissResult()} />
        )}
        <StagePanel session={session} readLevel={readLevel} snapshot={snapshot} />
      </div>
    </main>
  );
}
