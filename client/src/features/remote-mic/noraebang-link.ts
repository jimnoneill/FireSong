import { getVoiceEngine } from '@/audio/voice-engine';
import type { EchoMix } from '@/audio/voice-params';
import type { RemoteMics } from '@/bridge/remote-mics';
import { provideRevealSoundOutput } from '@/features/noraebang/audio/sound-output';
import { currentEchoPreset, phoneMicMonitoringForced } from '@/features/noraebang/echo';
import { subscribeNoraebangSettings } from '@/features/noraebang/settings';
import { registerSongResultSink } from '@/features/noraebang/song-result';

/**
 * The seams between the TV voice engine (WP4) and the noraebang presentation
 * (WP8), PROTOCOL.md §12. Only the TV (`?tv=1`) links them; an ordinary
 * browser keeps the noraebang fallbacks (no `song-result`, its own reveal
 * AudioContext).
 */

/** The echo preset's levels; the delay stays locked to each slot's latency. */
export const presetEchoMix = (): EchoMix => {
  const { wet, feedback, lowpassHz, reverbSend } = currentEchoPreset();
  return { wet, feedback, lowpassHz, reverbSend };
};

export const noraebangMonitorAlways = (): boolean => phoneMicMonitoringForced();

/** Registers the TV's sinks with the noraebang module; returns the unlink function. */
export const linkNoraebang = (mics: RemoteMics): (() => void) => {
  const unlinks = [
    registerSongResultSink({
      send: (frame) => {
        if (frame.type === 'song-result') {
          mics.sendSongResult(frame);
        }
      },
      slotForMicrophone: (microphoneId) => mics.slotForMicrophone(microphoneId),
    }),
    // The reveal mixes into the master limiter of the always-running voice
    // context, so the fanfare needs no gesture and goes out with the voices.
    provideRevealSoundOutput(() => {
      const engine = getVoiceEngine();
      return { context: engine.context, destination: engine.output };
    }),
    subscribeNoraebangSettings(() => mics.refreshSettings()),
  ];
  return () => {
    for (const unlink of unlinks) {
      unlink();
    }
  };
};
