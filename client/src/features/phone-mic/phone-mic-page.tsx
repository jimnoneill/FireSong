import { useState, type ReactNode } from 'react';

import { PartyMessages } from '@/features/phone-mic/components/party-messages';
import { PartyTab } from '@/features/phone-mic/components/party-tab';
import { QueueTab } from '@/features/phone-mic/components/queue-tab';
import { ScoreCard } from '@/features/phone-mic/components/score-card';
import { SingTab } from '@/features/phone-mic/components/sing-tab';
import { SongsTab } from '@/features/phone-mic/components/songs-tab';
import { StatusHeader } from '@/features/phone-mic/components/status-header';
import { TabBar } from '@/features/phone-mic/components/tab-bar';
import { panelId, tabId, type PhoneTab } from '@/features/phone-mic/components/tabs';
import { useStore } from '@/features/phone-mic/hooks/use-store';
import type { PhoneMicApp } from '@/features/phone-mic/lib/app';
import { useTranslation } from '@/i18n';

const JOINED_TABS: readonly PhoneTab[] = ['sing', 'songs', 'queue', 'party'];
const GUEST_TABS: readonly PhoneTab[] = ['sing', 'songs'];
const NO_FLAGS: ReadonlySet<PhoneTab> = new Set();
const SING_FLAG: ReadonlySet<PhoneTab> = new Set(['sing']);

type TabPanelProps = {
  tab: PhoneTab;
  current: PhoneTab;
  children: ReactNode;
};

/** Every panel stays mounted (hidden when not shown), so each keeps its scroll and state. */
function TabPanel({ tab, current, children }: TabPanelProps) {
  return (
    <div
      id={panelId(tab)}
      role="tabpanel"
      aria-labelledby={tabId(tab)}
      hidden={tab !== current}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      <div className="mx-auto max-w-md px-4 pt-4 pb-6">{children}</div>
    </div>
  );
}

/** Queue and Party need a slot; before joining only Sing (the join card) and Songs show. */
const visibleTab = (chosen: PhoneTab, joined: boolean): PhoneTab =>
  (joined ? JOINED_TABS : GUEST_TABS).includes(chosen) ? chosen : 'sing';

/**
 * `/m`: a guest's whole karaoke remote in one page. The mic session lives
 * above the tabs, so switching tabs never touches the peer connection or the socket.
 */
export function PhoneMicPage({ app }: { app: PhoneMicApp }) {
  useTranslation();
  const mic = useStore(app.session);
  const party = useStore(app.party);
  const [chosen, setChosen] = useState<PhoneTab>('sing');
  const joined = mic.stage === 'joined';
  const current = visibleTab(chosen, joined);
  const slot = mic.slot ?? app.session.requestedSlot;
  const offline = !joined || mic.link === 'offline';
  const shared = { app, party, slot, offline };

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {joined ? <StatusHeader mic={mic} slot={slot} name={app.session.singerName} /> : null}
      <TabPanel tab="sing" current={current}>
        <SingTab {...shared} mic={mic} />
      </TabPanel>
      <TabPanel tab="songs" current={current}>
        <SongsTab
          {...shared}
          joined={joined}
          active={current === 'songs'}
          onJoinFirst={() => setChosen('sing')}
        />
      </TabPanel>
      {joined ? (
        <TabPanel tab="queue" current={current}>
          <QueueTab {...shared} onBrowse={() => setChosen('songs')} />
        </TabPanel>
      ) : null}
      {joined ? (
        <TabPanel tab="party" current={current}>
          <PartyTab {...shared} />
        </TabPanel>
      ) : null}
      <PartyMessages party={party} controller={app.party} />
      <TabBar
        tabs={joined ? JOINED_TABS : GUEST_TABS}
        current={current}
        onSelect={setChosen}
        flagged={mic.unreachable && current !== 'sing' ? SING_FLAG : NO_FLAGS}
      />
      {mic.result === null ? null : (
        <ScoreCard
          result={mic.result}
          party={party}
          slot={slot}
          name={app.session.singerName}
          onDismiss={() => app.session.dismissResult()}
        />
      )}
    </div>
  );
}
