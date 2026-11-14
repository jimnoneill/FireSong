import {
  ListMusicIcon,
  MicVocalIcon,
  MusicIcon,
  PartyPopperIcon,
  type LucideIcon,
} from 'lucide-react';

import { panelId, tabId, type PhoneTab } from '@/features/phone-mic/components/tabs';
import { t, type TranslationKey } from '@/i18n';
import { cn } from '@/shared/utils/cn';

const TAB_INFO = {
  sing: { label: 'phoneMic.tabs.sing', icon: MicVocalIcon },
  songs: { label: 'phoneMic.tabs.songs', icon: MusicIcon },
  queue: { label: 'phoneMic.tabs.queue', icon: ListMusicIcon },
  party: { label: 'phoneMic.tabs.party', icon: PartyPopperIcon },
} satisfies Record<PhoneTab, { label: TranslationKey; icon: LucideIcon }>;

type TabBarProps = {
  tabs: readonly PhoneTab[];
  current: PhoneTab;
  onSelect: (tab: PhoneTab) => void;
  /** Tabs that want attention, such as Sing while the voice cannot reach the TV. */
  flagged: ReadonlySet<PhoneTab>;
};

/** The bottom tab bar: in-page panels only, so the mic and its socket never move. */
export function TabBar({ tabs, current, onSelect, flagged }: TabBarProps) {
  return (
    <nav className="shrink-0 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <div role="tablist" aria-label={t('phoneMic.tabs.label')} className="mx-auto flex max-w-md">
        {tabs.map((tab) => {
          const { label, icon: Icon } = TAB_INFO[tab];
          const selected = tab === current;
          return (
            <button
              key={tab}
              id={tabId(tab)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId(tab)}
              onClick={() => onSelect(tab)}
              className={cn(
                'relative flex min-h-16 flex-1 flex-col items-center justify-center gap-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              <Icon className={cn('size-6', selected ? 'text-primary' : '')} aria-hidden="true" />
              {t(label)}
              {flagged.has(tab) ? (
                <span
                  aria-hidden="true"
                  className="absolute top-2 right-[calc(50%-1.25rem)] size-2.5 rounded-full bg-destructive"
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
