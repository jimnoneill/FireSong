import { MIC_PAGE_PATH } from '@/features/remote-mic/protocol';

/** `true` for `/m` and `/m/`, the phone mic page. */
export const isPhoneMicPath = (pathname: string): boolean =>
  pathname.replace(/\/+$/, '') === MIC_PAGE_PATH;
