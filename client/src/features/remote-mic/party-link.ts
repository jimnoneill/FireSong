import { createFxSynth, type FxSynth } from '@/audio/fx-synth';
import { getVoiceEngine } from '@/audio/voice-engine';
import { flight } from '@/bridge/flight';
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

/**
 * The scoring beep on the voice backend's path; then, when the TV app plays
 * the voices, its monitor beep for the singer's own loop, which only goes to
 * the flight recorder. A backend that changes during the beep test fails it,
 * because the result would belong to neither.
 */
const measureOnBackend = async (mics: RemoteMics, deviceId: string): Promise<number> => {
  const backend = mics.backendSample()?.kind;
  const output = mics.calibrationOutput();
  if (backend === undefined || output === null) {
    throw new Error('no voice backend for the beep test');
  }
  const seconds = await measureMicLatencySec(deviceId, microphoneAdapter, output);
  if (mics.backendSample()?.kind !== backend) {
    throw new Error('the voice backend changed during the beep test');
  }
  const slot = mics.slotForMicrophone(deviceId);
  if (backend === 'native' && slot !== null) {
    flight('monitor-latency', { slot, monitorMs: await mics.measureMonitor(slot) });
  }
  return seconds;
};

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
    measure: (deviceId) => measureOnBackend(mics, deviceId),
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
