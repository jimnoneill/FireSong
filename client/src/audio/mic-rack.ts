import { SAMPLE_CHUNK } from '@/bridge/microphone.web';
import type { MicSlot } from '@/features/remote-mic/protocol';

import { FeedbackTracker, findFeedbackPeak } from './feedback-guard';
import { ACTIVE_PARAM, CHUNK_PROCESSOR, GATE_PROCESSOR, parseGateMeter } from './rack-worklets';
import type { VoiceEngine } from './voice-engine';
import {
  COMPRESSOR_RATIO,
  COMPRESSOR_THRESHOLD_DB,
  dbToGain,
  DEFAULT_ECHO_MIX,
  DEFAULT_SLOT_MIX,
  ECHO_HIGHPASS_HZ,
  echoSettingsFor,
  FEEDBACK_DUCK_DB,
  FEEDBACK_NOTCH_DB,
  FEEDBACK_NOTCH_Q,
  FEEDBACK_RELEASE_MS,
  GATE_THRESHOLD_DB,
  gainToDb,
  HPF_HZ,
  mixedEchoWet,
  VOICE_FALL_SEC,
  VOICE_FLOOR_DB,
  VOICE_HOWL_CUT_DB,
  VOICE_MAX_BOOST_DB,
  VOICE_RISE_SEC,
  VOICE_START_BOOST_DB,
  VOICE_TARGET_DB,
  type EchoMix,
  type EchoSettings,
  type SlotMix,
} from './voice-params';

const GUARD_INTERVAL_MS = 50;
const GUARD_FFT_SIZE = 2048;
const RAMP_SEC = 0.02;
const MAX_ECHO_DELAY_SEC = 1;
/** Latency follows the jitter buffer every 2 s; glide so the echo never clicks. */
const ECHO_GLIDE_SEC = 0.1;
/** Smaller latency moves leave the echo where it is. */
const ECHO_RETUNE_MS = 10;

/** Receives the slot's pre-FX, post-gate voice in 512-sample chunks. */
export type TapListener = (samples: Float32Array, sampleRate: number) => void;

/** Plays a remote stream into a muted media element; returns its release. */
export type StreamSink = (stream: MediaStream) => () => void;

export type RackSlotStatus = {
  attached: boolean;
  monitored: boolean;
  levelRms: number;
  /** The gate let the voice through on its last meter block. */
  gateOpen: boolean;
  muted: boolean;
  gateThreshold: number;
  feedbackHz: number | null;
  /** The automatic boost the slot applies to the phone's raw microphone, dB. */
  boostDb: number;
  echo: EchoSettings;
  /** The phone's own volume and echo amount. */
  mix: SlotMix;
};

/** What the remote-mics registry needs from the rack. */
export type MicRackPort = {
  attach(slot: MicSlot, stream: MediaStream): void;
  detach(slot: MicSlot): void;
  release(slot: MicSlot): void;
  setTap(slot: MicSlot, listener: TapListener | null): void;
  setMonitor(slot: MicSlot, on: boolean): void;
  setMuted(slot: MicSlot, muted: boolean): void;
  setLatency(slot: MicSlot, latencyMs: number | null): void;
  /** Echo and reverb levels of every slot (the echo preset); the echo delay is fixed. */
  setEchoMix(mix: EchoMix): void;
  /** The phone's own fader and echo amount (PROTOCOL.md §13.6 `mix`). */
  setSlotMix(slot: MicSlot, mix: SlotMix): void;
  status(slot: MicSlot): RackSlotStatus | null;
};

/**
 * Chromium leaves a remote WebRTC stream silent in Web Audio unless a media
 * element also plays it; a muted element is enough.
 */
const mutedElementSink: StreamSink = (stream) => {
  const element = new Audio();
  element.muted = true;
  element.srcObject = stream;
  element.play().catch(() => undefined);
  return () => {
    element.pause();
    element.srcObject = null;
  };
};

const ramp = (param: AudioParam, value: number, context: BaseAudioContext): void => {
  param.setTargetAtTime(value, context.currentTime, RAMP_SEC);
};

type StripNodes = {
  hpf: BiquadFilterNode;
  gate: AudioWorkletNode;
  chunker: AudioWorkletNode;
  analyser: AnalyserNode;
  level: GainNode;
  compressor: DynamicsCompressorNode;
  fader: GainNode;
  notch: BiquadFilterNode;
  monitor: GainNode;
  dry: GainNode;
  echoSend: GainNode;
  echoDelay: DelayNode;
  echoLowpass: BiquadFilterNode;
  echoHighpass: BiquadFilterNode;
  echoFeedback: GainNode;
  reverbSend: GainNode;
};

const buildStrip = (engine: VoiceEngine): StripNodes => {
  const { context } = engine;
  const hpf = context.createBiquadFilter();
  hpf.type = 'highpass';
  hpf.frequency.value = HPF_HZ;
  const gate = new AudioWorkletNode(context, GATE_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const chunker = new AudioWorkletNode(context, CHUNK_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    processorOptions: { chunkSize: SAMPLE_CHUNK },
  });
  const analyser = context.createAnalyser();
  analyser.fftSize = GUARD_FFT_SIZE;
  analyser.smoothingTimeConstant = 0;
  const level = context.createGain();
  level.gain.value = dbToGain(VOICE_START_BOOST_DB);
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = COMPRESSOR_THRESHOLD_DB;
  compressor.ratio.value = COMPRESSOR_RATIO;
  const notch = context.createBiquadFilter();
  notch.type = 'peaking';
  notch.Q.value = FEEDBACK_NOTCH_Q;
  notch.gain.value = 0;
  const fader = context.createGain();
  const monitor = context.createGain();
  monitor.gain.value = 0;
  const dry = context.createGain();
  const echoSend = context.createGain();
  const echoDelay = context.createDelay(MAX_ECHO_DELAY_SEC);
  const echoLowpass = context.createBiquadFilter();
  echoLowpass.type = 'lowpass';
  echoLowpass.frequency.value = DEFAULT_ECHO_MIX.lowpassHz;
  const echoHighpass = context.createBiquadFilter();
  echoHighpass.type = 'highpass';
  echoHighpass.frequency.value = ECHO_HIGHPASS_HZ;
  const echoFeedback = context.createGain();
  echoFeedback.gain.value = DEFAULT_ECHO_MIX.feedback;
  const reverbSend = context.createGain();
  reverbSend.gain.value = DEFAULT_ECHO_MIX.reverbSend;

  hpf.connect(gate);
  gate.connect(analyser);
  gate.connect(level).connect(compressor).connect(notch).connect(fader).connect(monitor);
  monitor.connect(dry).connect(engine.bus);
  monitor.connect(echoSend).connect(echoDelay);
  echoDelay.connect(echoLowpass).connect(echoHighpass);
  echoHighpass.connect(echoFeedback).connect(echoDelay);
  echoHighpass.connect(engine.bus);
  monitor.connect(reverbSend).connect(engine.reverbSend);

  return {
    hpf,
    gate,
    chunker,
    analyser,
    level,
    compressor,
    fader,
    notch,
    monitor,
    dry,
    echoSend,
    echoDelay,
    echoLowpass,
    echoHighpass,
    echoFeedback,
    reverbSend,
  };
};

class SlotStrip {
  private source: MediaStreamAudioSourceNode | null = null;
  private releaseSink: (() => void) | null = null;
  private tap: TapListener | null = null;
  private tapConnected = false;
  private monitored = false;
  private muted = false;
  private duckedUntil = 0;
  private mix: EchoMix = DEFAULT_ECHO_MIX;
  private slotMix: SlotMix = DEFAULT_SLOT_MIX;
  private latencyMs: number | null = null;
  private echo: EchoSettings = echoSettingsFor(null);
  private readonly gateThreshold = dbToGain(GATE_THRESHOLD_DB);
  private levelRms = 0;
  private gateOpen = false;
  private feedbackHz: number | null = null;
  /** Follows the loud parts of the singing (linear RMS). */
  private singing = dbToGain(VOICE_TARGET_DB - VOICE_START_BOOST_DB);
  private boostDb = VOICE_START_BOOST_DB;
  private boostCeilingDb = VOICE_MAX_BOOST_DB;
  private levelledAt = 0;
  private readonly tracker = new FeedbackTracker();
  private readonly spectrum: Float32Array<ArrayBuffer>;
  private readonly onMeter = (event: MessageEvent<unknown>) => this.meter(event.data);
  private readonly onChunk = (event: MessageEvent<unknown>) => this.chunk(event.data);

  constructor(
    private readonly engine: VoiceEngine,
    private readonly nodes: StripNodes,
    private readonly sink: StreamSink,
  ) {
    this.spectrum = new Float32Array(nodes.analyser.frequencyBinCount);
    nodes.gate.parameters.get('threshold')?.setValueAtTime(this.gateThreshold, 0);
    nodes.gate.port.addEventListener('message', this.onMeter);
    nodes.gate.port.start();
    nodes.chunker.port.addEventListener('message', this.onChunk);
    nodes.chunker.port.start();
    this.applyEcho();
  }

  attach(stream: MediaStream): void {
    this.detach();
    this.releaseSink = this.sink(stream);
    this.source = this.engine.context.createMediaStreamSource(stream);
    this.source.connect(this.nodes.hpf);
    this.syncTap();
  }

  detach(): void {
    this.source?.disconnect();
    this.source = null;
    this.releaseSink?.();
    this.releaseSink = null;
    this.tracker.reset();
    this.syncTap();
  }

  dispose(): void {
    this.detach();
    this.setTap(null);
    for (const processor of [this.nodes.gate, this.nodes.chunker]) {
      processor.parameters.get(ACTIVE_PARAM)?.setValueAtTime(0, this.engine.context.currentTime);
    }
    for (const node of Object.values(this.nodes)) {
      node.disconnect();
    }
    this.nodes.gate.port.removeEventListener('message', this.onMeter);
    this.nodes.chunker.port.removeEventListener('message', this.onChunk);
  }

  setTap(listener: TapListener | null): void {
    this.tap = listener;
    this.syncTap();
  }

  setMonitor(on: boolean): void {
    this.monitored = on;
    ramp(this.nodes.monitor.gain, on ? 1 : 0, this.engine.context);
    if (!on) {
      this.tracker.reset();
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyFader();
  }

  setLatency(latencyMs: number | null): void {
    this.latencyMs = latencyMs;
    const next = echoSettingsFor(latencyMs, this.mix);
    if (
      next.late === this.echo.late &&
      Math.abs(next.delayMs - this.echo.delayMs) < ECHO_RETUNE_MS
    ) {
      return;
    }
    this.echo = next;
    this.applyEcho();
  }

  setMix(mix: EchoMix): void {
    this.mix = mix;
    this.echo = echoSettingsFor(this.latencyMs, mix);
    const { context } = this.engine;
    ramp(this.nodes.echoFeedback.gain, mix.feedback, context);
    ramp(this.nodes.echoLowpass.frequency, mix.lowpassHz, context);
    ramp(this.nodes.reverbSend.gain, mix.reverbSend, context);
    this.applyEcho();
  }

  setSlotMix(mix: SlotMix): void {
    this.slotMix = mix;
    this.applyFader();
    this.applyEcho();
  }

  /** One feedback-guard step: notch and duck a confirmed howl, and release both once it is gone. */
  guard(nowMs: number): void {
    this.levelVoice(nowMs);
    if (this.duckedUntil !== 0 && nowMs >= this.duckedUntil) {
      this.duckedUntil = 0;
      this.feedbackHz = null;
      ramp(this.nodes.notch.gain, 0, this.engine.context);
      this.applyFader();
    }
    if (!this.monitored || this.source === null) {
      return;
    }
    this.nodes.analyser.getFloatFrequencyData(this.spectrum);
    const peak = findFeedbackPeak(this.spectrum, this.engine.context.sampleRate);
    const howlHz = this.tracker.update(peak, nowMs);
    if (howlHz === null) {
      if (peak !== null && this.duckedUntil !== 0) {
        this.duckedUntil = nowMs + FEEDBACK_RELEASE_MS;
      }
      return;
    }
    this.feedbackHz = howlHz;
    this.boostCeilingDb = Math.max(0, this.boostCeilingDb - VOICE_HOWL_CUT_DB);
    this.applyBoost(Math.min(this.boostDb, this.boostCeilingDb));
    this.nodes.notch.frequency.setValueAtTime(howlHz, this.engine.context.currentTime);
    ramp(this.nodes.notch.gain, FEEDBACK_NOTCH_DB, this.engine.context);
    this.duckedUntil = nowMs + FEEDBACK_RELEASE_MS;
    this.applyFader();
  }

  status(): RackSlotStatus {
    return {
      attached: this.source !== null,
      monitored: this.monitored,
      levelRms: this.levelRms,
      gateOpen: this.gateOpen,
      muted: this.muted,
      gateThreshold: this.gateThreshold,
      feedbackHz: this.feedbackHz,
      boostDb: Math.round(this.boostDb * 10) / 10,
      echo: this.echo,
      mix: this.slotMix,
    };
  }

  /** Frames flow only while someone listens and the slot has audio. */
  private syncTap(): void {
    const wanted = this.tap !== null && this.source !== null;
    if (wanted === this.tapConnected) {
      return;
    }
    if (wanted) {
      this.nodes.level.connect(this.nodes.chunker);
    } else {
      this.nodes.level.disconnect(this.nodes.chunker);
    }
    this.tapConnected = wanted;
  }

  /** One auto-level step on the latest meter block (see VOICE_TARGET_DB). */
  private levelVoice(nowMs: number): void {
    const elapsedSec = this.levelledAt === 0 ? 0 : (nowMs - this.levelledAt) / 1000;
    this.levelledAt = nowMs;
    if (this.source === null || !this.gateOpen || gainToDb(this.levelRms) < VOICE_FLOOR_DB) {
      return;
    }
    const seconds = this.levelRms > this.singing ? VOICE_RISE_SEC : VOICE_FALL_SEC;
    this.singing += (this.levelRms - this.singing) * (1 - Math.exp(-elapsedSec / seconds));
    const wanted = Math.min(
      this.boostCeilingDb,
      Math.max(0, VOICE_TARGET_DB - gainToDb(this.singing)),
    );
    if (Math.abs(wanted - this.boostDb) >= 0.5) {
      this.applyBoost(wanted);
    }
  }

  private applyBoost(db: number): void {
    this.boostDb = db;
    this.nodes.level.gain.setTargetAtTime(dbToGain(db), this.engine.context.currentTime, 0.25);
  }

  private applyFader(): void {
    const ducked = this.duckedUntil !== 0 ? dbToGain(FEEDBACK_DUCK_DB) : 1;
    ramp(this.nodes.fader.gain, this.muted ? 0 : ducked * this.slotMix.volume, this.engine.context);
  }

  private applyEcho(): void {
    const { context } = this.engine;
    this.nodes.echoDelay.delayTime.setTargetAtTime(
      this.echo.delayMs / 1000,
      context.currentTime,
      ECHO_GLIDE_SEC,
    );
    ramp(this.nodes.dry.gain, this.echo.dryGain, context);
    ramp(this.nodes.echoSend.gain, mixedEchoWet(this.echo.wetGain, this.slotMix), context);
  }

  private meter(data: unknown): void {
    const meter = parseGateMeter(data);
    if (meter === null) {
      return;
    }
    this.levelRms = meter.rms;
    this.gateOpen = meter.open;
  }

  private chunk(data: unknown): void {
    if (this.tap !== null && data instanceof Float32Array) {
      this.tap(data, this.engine.context.sampleRate);
    }
  }
}

/**
 * Per-slot voice chains on the shared voice engine:
 * source -> HPF -> gate -> level -> compressor -> notch -> fader -> monitor,
 * which feeds the dry bus, the noraebang echo and the shared reverb. The
 * pitch tap sits after the level (the automatic boost) and before any effect,
 * so a quiet phone still scores. Each slot is
 * independent, so one phone dropping never touches the others.
 */
export class MicRack implements MicRackPort {
  private readonly strips = new Map<MicSlot, SlotStrip>();
  private guardTimer: number | null = null;
  private mix: EchoMix = DEFAULT_ECHO_MIX;

  private constructor(
    private readonly engine: VoiceEngine,
    private readonly sink: StreamSink,
  ) {}

  static async create(engine: VoiceEngine, sink: StreamSink = mutedElementSink): Promise<MicRack> {
    await engine.ready;
    return new MicRack(engine, sink);
  }

  attach(slot: MicSlot, stream: MediaStream): void {
    this.strip(slot).attach(stream);
  }

  detach(slot: MicSlot): void {
    this.strips.get(slot)?.detach();
  }

  release(slot: MicSlot): void {
    this.strips.get(slot)?.dispose();
    this.strips.delete(slot);
    if (this.strips.size === 0) {
      this.stopGuard();
    }
  }

  setTap(slot: MicSlot, listener: TapListener | null): void {
    if (listener === null && !this.strips.has(slot)) {
      return;
    }
    this.strip(slot).setTap(listener);
  }

  setMonitor(slot: MicSlot, on: boolean): void {
    if (!on && !this.strips.has(slot)) {
      return;
    }
    this.strip(slot).setMonitor(on);
  }

  setMuted(slot: MicSlot, muted: boolean): void {
    this.strip(slot).setMuted(muted);
  }

  setLatency(slot: MicSlot, latencyMs: number | null): void {
    this.strip(slot).setLatency(latencyMs);
  }

  setEchoMix(mix: EchoMix): void {
    this.mix = mix;
    for (const strip of this.strips.values()) {
      strip.setMix(mix);
    }
  }

  setSlotMix(slot: MicSlot, mix: SlotMix): void {
    this.strip(slot).setSlotMix(mix);
  }

  status(slot: MicSlot): RackSlotStatus | null {
    return this.strips.get(slot)?.status() ?? null;
  }

  private strip(slot: MicSlot): SlotStrip {
    let strip = this.strips.get(slot);
    if (strip === undefined) {
      strip = new SlotStrip(this.engine, buildStrip(this.engine), this.sink);
      if (this.mix !== DEFAULT_ECHO_MIX) {
        strip.setMix(this.mix);
      }
      this.strips.set(slot, strip);
      this.startGuard();
    }
    return strip;
  }

  private startGuard(): void {
    this.guardTimer ??= window.setInterval(() => {
      const now = performance.now();
      for (const strip of this.strips.values()) {
        strip.guard(now);
      }
    }, GUARD_INTERVAL_MS);
  }

  private stopGuard(): void {
    if (this.guardTimer !== null) {
      window.clearInterval(this.guardTimer);
      this.guardTimer = null;
    }
  }
}
