import { describe, expect, it } from 'vitest';

import { createRevealSynth } from '@/features/noraebang/audio/reveal-synth';

class FakeParam {
  value = 0;
  setValueAtTime() {
    return this;
  }
  exponentialRampToValueAtTime() {
    return this;
  }
  linearRampToValueAtTime() {
    return this;
  }
}

const nodes: FakeNode[] = [];

class FakeNode extends EventTarget {
  readonly outputs = new Set<FakeNode>();
  readonly gain = new FakeParam();
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
  readonly detune = new FakeParam();
  readonly threshold = new FakeParam();
  readonly ratio = new FakeParam();
  type = '';
  buffer: unknown = null;
  loop = false;
  started = false;
  constructor() {
    super();
    nodes.push(this);
  }
  connect(node: FakeNode) {
    this.outputs.add(node);
    return node;
  }
  disconnect() {
    this.outputs.clear();
  }
  start() {
    this.started = true;
  }
  stop() {}
}

const fakeOutput = () => {
  nodes.length = 0;
  const node = () => new FakeNode();
  const context = {
    currentTime: 0,
    sampleRate: 48_000,
    createGain: node,
    createDynamicsCompressor: node,
    createBiquadFilter: node,
    createOscillator: node,
    createBufferSource: node,
    createBuffer: (_channels: number, length: number) => ({
      getChannelData: () => new Float32Array(length),
    }),
  };
  const destination = new FakeNode();
  const feeding = () => nodes.filter((candidate) => candidate.outputs.has(destination)).length;
  const endAll = () => {
    for (const source of nodes.filter((candidate) => candidate.started)) {
      source.dispatchEvent(new Event('ended'));
    }
  };
  return {
    output: { context, destination } as unknown as Parameters<typeof createRevealSynth>[0],
    feeding,
    endAll,
  };
};

describe('createRevealSynth', () => {
  it('is wired to the output only while something sounds', () => {
    const { output, feeding, endAll } = fakeOutput();
    const synth = createRevealSynth(output);
    expect(feeding()).toBe(0);

    synth.slam();
    expect(feeding()).toBe(1);
    endAll();
    expect(feeding()).toBe(0);

    synth.drumRoll(1);
    synth.celebrate('perfect');
    expect(feeding()).toBe(1);
    synth.stop();
    expect(feeding()).toBe(0);
    endAll();
    expect(feeding()).toBe(0);

    synth.celebrate('good');
    expect(feeding()).toBe(1);
  });
});
