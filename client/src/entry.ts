import { isPhoneMicPath } from '@/features/phone-mic/route';

/**
 * Guests' phones open `/m` and get only the small mic bundle; every other
 * path loads the full client.
 */
const loadPage = (): Promise<unknown> =>
  isPhoneMicPath(window.location.pathname) ? import('@/features/phone-mic/main') : import('@/main');

loadPage().catch((error: unknown) => reportError(error));
