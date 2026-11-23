import type { NativeMicLinkPort } from './native-mic-protocol';
import type { PeerInit, PeerPort } from './remote-mic-peer';

/**
 * The TV end of one phone's connection when the app's voice engine receives
 * it: offers, candidates and closes become mics-protocol messages for one
 * page-chosen peer id.
 */
export class NativeMicPeer implements PeerPort {
  readonly micId: string;

  constructor(_link: NativeMicLinkPort, init: PeerInit) {
    this.micId = init.micId;
  }

  acceptOffer(): Promise<void> {
    return Promise.reject(new Error('native mic peer unavailable'));
  }

  addIce(): void {}

  close(): void {}
}
