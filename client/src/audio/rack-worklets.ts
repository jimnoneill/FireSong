/** The MicRack's processors, one worklet module on the voice engine context. */
export const GATE_PROCESSOR = 'firesong-gate';
export const CHUNK_PROCESSOR = 'firesong-chunker';

/**
 * k-rate parameter on both processors; setting it to 0 ends the processor
 * (process() returns false). The voice engine's context is never closed, so a
 * processor that kept returning true would run on the audio thread after its
 * slot is released.
 */
export const ACTIVE_PARAM = 'active';

/** Readings the gate posts about every 50 ms: mean-square level as RMS. */
export type GateMeter = { rms: number; open: boolean };

const RACK_SRC = `
const coefficient = (seconds) => Math.exp(-1 / (sampleRate * seconds));
const ACTIVE = { name: ${JSON.stringify(ACTIVE_PARAM)}, defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' };
const ended = (parameters) => parameters[${JSON.stringify(ACTIVE_PARAM)}][0] < 0.5;
class FireSongGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'threshold', defaultValue: 0.001, minValue: 0, maxValue: 1, automationRate: 'k-rate' }, ACTIVE];
  }
  constructor() {
    super();
    this.envelope = 0;
    this.gain = 0;
    this.hold = 0;
    this.envelopeAttack = coefficient(0.002);
    this.envelopeRelease = coefficient(0.05);
    this.gainAttack = coefficient(0.002);
    this.gainRelease = coefficient(0.12);
    this.holdSamples = Math.round(sampleRate * 0.08);
    this.meterSamples = Math.round(sampleRate * 0.05);
    this.meterSum = 0;
    this.meterCount = 0;
  }
  process(inputs, outputs, parameters) {
    if (ended(parameters)) return false;
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;
    const input = inputs[0];
    const channels = input ? input.length : 0;
    const open = parameters.threshold[0];
    const close = open * 0.5;
    for (let i = 0; i < output.length; i++) {
      let sample = 0;
      for (let c = 0; c < channels; c++) sample += input[c][i];
      if (channels > 0) sample /= channels;
      const square = sample * sample;
      const k = square > this.envelope ? this.envelopeAttack : this.envelopeRelease;
      this.envelope = k * this.envelope + (1 - k) * square;
      const rms = Math.sqrt(this.envelope);
      if (rms >= open || (this.hold > 0 && rms >= close)) this.hold = this.holdSamples;
      else if (this.hold > 0) this.hold--;
      const target = this.hold > 0 ? 1 : 0;
      const g = target > this.gain ? this.gainAttack : this.gainRelease;
      this.gain = g * this.gain + (1 - g) * target;
      output[i] = sample * this.gain;
      this.meterSum += square;
      this.meterCount++;
      if (this.meterCount >= this.meterSamples) {
        this.port.postMessage({ rms: Math.sqrt(this.meterSum / this.meterCount), open: this.hold > 0 });
        this.meterSum = 0;
        this.meterCount = 0;
      }
    }
    return true;
  }
}
class FireSongChunker extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [ACTIVE];
  }
  constructor(options) {
    super();
    this.chunkSize = (options && options.processorOptions && options.processorOptions.chunkSize) || 512;
    this.buffer = new Float32Array(this.chunkSize);
    this.offset = 0;
  }
  process(inputs, outputs, parameters) {
    if (ended(parameters)) return false;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channels = input.length;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let sample = 0;
      for (let c = 0; c < channels; c++) sample += input[c][i];
      this.buffer[this.offset++] = sample / channels;
      if (this.offset >= this.chunkSize) {
        this.port.postMessage(this.buffer.slice(0));
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(GATE_PROCESSOR)}, FireSongGate);
registerProcessor(${JSON.stringify(CHUNK_PROCESSOR)}, FireSongChunker);
`;

let rackUrl: string | null = null;

export const rackWorkletUrl = (): string => {
  rackUrl ??= URL.createObjectURL(new Blob([RACK_SRC], { type: 'application/javascript' }));
  return rackUrl;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const parseGateMeter = (value: unknown): GateMeter | null => {
  if (!isRecord(value) || typeof value.rms !== 'number' || typeof value.open !== 'boolean') {
    return null;
  }
  return { rms: value.rms, open: value.open };
};
