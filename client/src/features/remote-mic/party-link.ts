import { createFxSynth, type FxSynth } from '@/audio/fx-synth';
import { getVoiceEngine } from '@/audio/voice-engine';
import { microphoneAdapter } from '@/bridge/microphone';
import type { RemoteMics, TvPartyEvent } from '@/bridge/remote-mics';
import { measureMicLatencySec } from '@/features/microphone/lib/latency-test';
import { partyTv } from '@/features/party-lobby/party-store';

import { CALIBRATION_SETTLE_MS, PhoneCalibrator } from './phone-calibration';
import { isMicSlot, type FxSound } from './protocol';

/**
 * The TV's party channel (PROTOCOL.md §13) on the `/rtc` socket: snapshots,
 * the phone remote, fun sounds and phone-started calibration. Only the TV
 * (`?tv=1`) links it, from the party host.
 */

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export const linkParty = (mics: RemoteMics): (() => void) => {
  let synth: FxSynth | null = null;
  const fx = (): FxSynth => {
    if (synth === null) {
      const engine = getVoiceEngine();
      synth = createFxSynth({ context: engine.context, destination: engine.output });
    }
    return synth;
  };

  const calibrator = new PhoneCalibrator({
    measure: (deviceId) => {
      const engine = getVoiceEngine();
      return measureMicLatencySec(deviceId, microphoneAdapter, {
        context: engine.context,
        destination: engine.output,
      });
    },
    send: (frame) => mics.sendParty(frame),
    reportLatency: (micId, latencyMs, method) => mics.reportLatency(micId, latencyMs, method),
    hasAudio: (slot) => mics.slotStatus(slot)?.attached === true,
    idle: () => partyTv.getState().stage.state === 'lobby',
    setTuning: (slot) => partyTv.setTuning(slot),
    settle: () => sleep(CALIBRATION_SETTLE_MS),
  });

  const playFx = (slot: number, sound: FxSound): void => {
    if (!isMicSlot(slot)) {
      return;
    }
    if (fx().play(sound)) {
      partyTv.flash(slot, sound);
    } else {
      partyTv.countDroppedFx();
    }
  };

  const onEvent = (event: TvPartyEvent): void => {
    if (event.kind === 'ready') {
      partyTv.onReady();
      return;
    }
    const { frame } = event;
    switch (frame.type) {
      case 'party':
        partyTv.setSnapshot(frame.party);
        return;
      case 'control':
        partyTv.control(frame.action);
        return;
      case 'shift-current':
        if (isMicSlot(frame.slot)) {
          partyTv.shiftCurrent(frame.slot, frame.keyOffset, frame.tempo);
        }
        return;
      case 'fx':
        playFx(frame.slot, frame.sound);
        return;
      case 'calibrate':
        if (isMicSlot(frame.slot)) {
          calibrator.run(frame.slot, frame.micId);
        }
    }
  };

  const detach = partyTv.attachSink({ send: (frame) => mics.sendParty(frame) });
  const unsubscribe = mics.subscribeParty(onEvent);
  return () => {
    unsubscribe();
    detach();
  };
};
