import type { PhoneMicLink, PhoneMicProblem } from '@/features/phone-mic/lib/session';
import { t, type TranslationKey } from '@/i18n';

const PROBLEM_KEYS = {
  'mic-denied': 'phoneMic.problem.micDenied',
  'mic-unavailable': 'phoneMic.problem.micUnavailable',
  'slots-full': 'phoneMic.problem.slotsFull',
  replaced: 'phoneMic.problem.replaced',
  kicked: 'phoneMic.problem.kicked',
  'bad-request': 'phoneMic.problem.badRequest',
} satisfies Record<PhoneMicProblem, TranslationKey>;

const LINK_KEYS = {
  offline: 'phoneMic.link.offline',
  'waiting-tv': 'phoneMic.link.waitingTv',
  connecting: 'phoneMic.link.connecting',
  live: 'phoneMic.link.live',
} satisfies Record<PhoneMicLink, TranslationKey>;

export const problemMessage = (problem: PhoneMicProblem): string => t(PROBLEM_KEYS[problem]);

export const linkMessage = (link: PhoneMicLink): string => t(LINK_KEYS[link]);
