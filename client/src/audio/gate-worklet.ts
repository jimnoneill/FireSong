export const GATE_PROCESSOR = 'firesong-gate';

/** Readings the gate posts about every 50 ms: mean-square level as RMS. */
export type GateMeter = { rms: number; open: boolean };

const GATE_SRC = `
const coefficient = (seconds) => Math.exp(-1 / (sampleRate * seconds));
class FireSongGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'threshold', defaultValue: 0.001, minValue: 0, maxValue: 1, automationRate: 'k-rate' }];
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
registerProcessor(${JSON.stringify(GATE_PROCESSOR)}, FireSongGate);
`;

let gateUrl: string | null = null;

export const gateWorkletUrl = (): string => {
  gateUrl ??= URL.createObjectURL(new Blob([GATE_SRC], { type: 'application/javascript' }));
  return gateUrl;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const parseGateMeter = (value: unknown): GateMeter | null => {
  if (!isRecord(value) || typeof value.rms !== 'number' || typeof value.open !== 'boolean') {
    return null;
  }
  return { rms: value.rms, open: value.open };
};
