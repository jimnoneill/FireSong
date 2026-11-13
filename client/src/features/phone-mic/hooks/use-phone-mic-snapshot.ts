import { useSyncExternalStore } from 'react';

import type { PhoneMicSession, PhoneMicSnapshot } from '@/features/phone-mic/lib/session';

export const usePhoneMicSnapshot = (session: PhoneMicSession): PhoneMicSnapshot =>
  useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
