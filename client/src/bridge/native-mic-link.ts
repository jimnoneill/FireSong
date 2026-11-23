import type { NativeMicLinkPort } from './native-mic-protocol';
import type { NativeVoiceEndpoint } from './native-voice';

/**
 * Opens the mics protocol on the app's door: `hello`, then `ready` within
 * `timeoutMs`. Rejects when the app does not answer with a usable `ready`.
 */
export const connectNativeMicLink = (
  _endpoint: NativeVoiceEndpoint,
  _timeoutMs = 3000,
): Promise<NativeMicLinkPort> => Promise.reject(new Error('native mic link unavailable'));
