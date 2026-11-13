import { isMicSlot, type MicSlot } from '@/features/remote-mic/protocol';

const SLOT_PARAM = /^[1-4]$/;

/** The slot printed on the QR code (`?slot=N`), or `null` when absent or invalid. */
export const joinLinkSlot = (search: string): MicSlot | null => {
  const raw = new URLSearchParams(search).get('slot');
  if (raw === null || !SLOT_PARAM.test(raw)) {
    return null;
  }

  const slot = Number(raw);
  return isMicSlot(slot) ? slot : null;
};

/**
 * The page URL without the pairing token, or `null` when it carries none.
 * The server has already turned `?t=` into a cookie by the time this runs.
 */
export const urlWithoutPairingToken = (href: string): string | null => {
  const url = new URL(href);
  if (!url.searchParams.has('t')) {
    return null;
  }

  url.searchParams.delete('t');
  return url.toString();
};

/** The `/rtc` socket on the origin that served the page. */
export const rtcSocketUrl = (location: { protocol: string; host: string }): string =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/rtc`;
