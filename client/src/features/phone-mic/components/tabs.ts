export type PhoneTab = 'sing' | 'songs' | 'queue' | 'party';

export const tabId = (tab: PhoneTab): string => `phone-tab-${tab}`;

export const panelId = (tab: PhoneTab): string => `phone-panel-${tab}`;
