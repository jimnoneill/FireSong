// TV side of the headless harness. It runs the real client modules (voice
// engine, MicRack, remote-mics, the wrapped MicrophoneAdapter, useMicCapture
// and useMicPitch) and exposes what the test needs on `window.harness`.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';

import { getVoiceEngine } from '@/audio/voice-engine';
import { microphoneAdapter } from '@/bridge/microphone';
import { subscribeMicSamples } from '@/bridge/microphone-samples';
import { remoteMics, startRemoteMics } from '@/bridge/remote-mics';
import { useMicCapture, useMicPitch } from '@/features/microphone/hooks/use-mic-pitch';

type PlayerSpec = { captureId: string; deviceId: string; monitor: boolean };

const RECORDER_SRC = `
class HarnessRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const frames = input[0].length;
      const mono = new Float32Array(frames);
      for (let c = 0; c < input.length; c++) {
        for (let i = 0; i < frames; i++) mono[i] += input[c][i] / input.length;
      }
      this.port.postMessage(mono);
    }
    return true;
  }
}
registerProcessor('harness-recorder', HarnessRecorder);
`;

const players = { list: [] as PlayerSpec[], listeners: new Set<() => void>() };
const frames: Record<string, number[]> = {};
const frameLevels: Record<string, number[]> = {};
const pitches: Record<string, (number | null)[]> = {};
let deviceChanges = 0;
let recording: Float32Array[] | null = null;

navigator.mediaDevices?.addEventListener('devicechange', () => {
  deviceChanges += 1;
});

const setPlayers = (list: PlayerSpec[]) => {
  players.list = list;
  players.listeners.forEach((listener) => listener());
};

const usePlayers = () =>
  useSyncExternalStore(
    (listener) => {
      players.listeners.add(listener);
      return () => players.listeners.delete(listener);
    },
    () => players.list,
  );

function PlayerProbe({ spec }: { spec: PlayerSpec }) {
  const options = { emit_audio: spec.monitor };
  const { active, error } = useMicCapture({
    captureId: spec.captureId,
    deviceId: spec.deviceId,
    enabled: true,
    options,
  });
  const { latestPitch } = useMicPitch(spec.captureId, true);
  const latest = useRef<number | null>(null);
  latest.current = latestPitch;

  useEffect(() => {
    const times = (frames[spec.captureId] ??= []);
    const levels = (frameLevels[spec.captureId] ??= []);
    return subscribeMicSamples(spec.captureId, (frame) => {
      times.push(performance.now());
      let sum = 0;
      for (const sample of frame.samples) {
        sum += sample * sample;
      }
      levels.push(Math.sqrt(sum / Math.max(1, frame.samples.length)));
    });
  }, [spec.captureId]);

  useEffect(() => {
    const timer = setInterval(() => (pitches[spec.captureId] ??= []).push(latest.current), 33);
    return () => clearInterval(timer);
  }, [spec.captureId]);

  return (
    <p data-capture={spec.captureId}>
      {spec.captureId}: {active ? 'active' : 'idle'} {error ?? ''}
    </p>
  );
}

function Harness() {
  const list = usePlayers();
  return (
    <>
      {list.map((spec) => (
        <PlayerProbe key={spec.captureId} spec={spec} />
      ))}
    </>
  );
}

const startRecorder = async () => {
  const engine = getVoiceEngine();
  await engine.ready;
  const url = URL.createObjectURL(new Blob([RECORDER_SRC], { type: 'application/javascript' }));
  await engine.context.audioWorklet.addModule(url);
  const recorder = new AudioWorkletNode(engine.context, 'harness-recorder', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  });
  recorder.port.onmessage = (event: MessageEvent<Float32Array>) => recording?.push(event.data);
  engine.output.connect(recorder);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const harness = {
  ready: false,
  setPlayers,
  devices: () => microphoneAdapter.listDevices(true),
  snapshot: () => {
    const snapshot = remoteMics.getSnapshot();
    return { ...snapshot, latencyMs: Object.fromEntries(snapshot.latencyMs) };
  },
  deviceChanges: () => deviceChanges,
  frameTimes: (captureId: string) => frames[captureId] ?? [],
  /** RMS of each frame, aligned with `frameTimes`. */
  frameLevels: (captureId: string) => frameLevels[captureId] ?? [],
  pitches: (captureId: string) => pitches[captureId] ?? [],
  clearPitches: (captureId: string) => {
    pitches[captureId] = [];
  },
  slotStatus: (slot: 1 | 2 | 3 | 4) => remoteMics.slotStatus(slot),
  engine: () => {
    const { context } = getVoiceEngine();
    return {
      state: context.state,
      sampleRate: context.sampleRate,
      baseLatency: context.baseLatency,
      outputLatency: context.outputLatency,
    };
  },
  /** Records the voice engine's output (after the limiter) for `ms`. */
  record: async (ms: number) => {
    recording = [];
    await sleep(ms);
    const chunks = recording;
    recording = null;
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return Array.from(out);
  },
};

Object.assign(window, { harness });

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(<Harness />);
}

startRemoteMics();
startRecorder()
  .then(() => {
    harness.ready = true;
    return undefined;
  })
  .catch((error: unknown) => {
    Object.assign(window, { harnessError: String(error) });
  });
