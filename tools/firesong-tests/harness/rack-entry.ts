// Page for rack-release.test.ts: the real MicRack on the real voice engine,
// with every AudioWorkletNode the rack builds recorded so the test can probe
// the processors after the slot is released.
import { MicRack } from '@/audio/mic-rack';
import { getVoiceEngine } from '@/audio/voice-engine';

type Recorded = { name: string; node: AudioWorkletNode; messages: number };

const recorded: Recorded[] = [];
const Native = window.AudioWorkletNode;
window.AudioWorkletNode = class extends Native {
  constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
    super(context, name, options);
    const entry = { name, node: this, messages: 0 };
    this.port.addEventListener('message', () => {
      entry.messages += 1;
    });
    this.port.start();
    recorded.push(entry);
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const counts = () => recorded.map((entry) => entry.messages);

const run = async () => {
  const engine = getVoiceEngine();
  await engine.resume();
  const rack = await MicRack.create(engine, () => () => undefined);
  const tone = engine.context.createOscillator();
  const stream = engine.context.createMediaStreamDestination();
  tone.connect(stream);
  tone.start();

  rack.attach(1, stream.stream);
  rack.setTap(1, () => undefined);
  rack.setMonitor(1, true);
  await sleep(600);
  const live = counts();

  rack.release(1);
  // Feed every released processor again: a live one would keep posting.
  const probe = engine.context.createConstantSource();
  probe.offset.value = 0.25;
  probe.start();
  for (const { node } of recorded) {
    probe.connect(node);
  }
  await sleep(400);
  const settled = counts();
  await sleep(1200);
  return { names: recorded.map((entry) => entry.name), live, settled, after: counts() };
};

declare global {
  interface Window {
    rackRelease: () => ReturnType<typeof run>;
  }
}

window.rackRelease = run;
