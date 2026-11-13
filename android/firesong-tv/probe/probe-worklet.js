// AudioWorklet module for the S1 probe: proves addModule() works and that the
// audio rendering thread actually calls process().
class FsProbeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blocks = 0;
    this.sent = false;
  }

  process(inputs, outputs) {
    this.blocks += 1;
    if (!this.sent && this.blocks >= 50) {
      this.sent = true;
      this.port.postMessage({ blocks: this.blocks, sampleRate, frameSize: outputs[0]?.[0]?.length ?? null, currentTime });
    }
    return true;
  }
}

registerProcessor('fs-probe', FsProbeProcessor);
