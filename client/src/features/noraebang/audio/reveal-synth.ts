/**
 * Synthesised score-reveal sounds: a snare drum roll, a kick-and-crash slam,
 * and a brass fanfare per tier. Everything is generated with Web Audio at
 * play time; there are no sample files. The motifs are plain major-key
 * arpeggios written for FireSong.
 */

import type { ScoreTier } from '@/features/remote-mic/protocol';

export type RevealSounds = {
  /** Snare roll that speeds up and swells over `durationSec`. */
  drumRoll: (durationSec: number) => void;
  /** Kick and cymbal crash on the final number. */
  slam: () => void;
  /** The tier's stinger; `perfect` gets the long fanfare. */
  celebrate: (tier: ScoreTier) => void;
  /** Silences everything still sounding. */
  stop: () => void;
};

export const SILENT_REVEAL_SOUNDS: RevealSounds = {
  drumRoll: () => {},
  slam: () => {},
  celebrate: () => {},
  stop: () => {},
};

export type SoundOutput = {
  context: BaseAudioContext;
  destination: AudioNode;
};

/** [MIDI note, start beat, length in beats] */
type Note = readonly [number, number, number];

const BEAT_SEC = 0.15;
const MASTER_GAIN = 0.55;
const NOISE_SEC = 1;

const C_MAJOR_CALL: readonly Note[] = [
  [67, 0, 1],
  [72, 1, 1],
  [76, 2, 1],
  [79, 3, 3],
];
const C_MAJOR_CHORD = [72, 76, 79, 84] as const;
const D_MAJOR_ANSWER: readonly Note[] = [
  [69, 10, 1],
  [74, 11, 1],
  [78, 12, 1],
  [81, 13, 2],
  [78, 15, 1],
  [81, 16, 1],
];
const D_MAJOR_CHORD = [74, 78, 81, 86] as const;
const SPARKLE_NOTES = [86, 90, 93, 98] as const;
const RETRY_NOTES: readonly Note[] = [
  [67, 0, 2],
  [66, 2, 2],
  [65, 4, 2],
  [64, 6, 6],
];

const midiHz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

function envelope(gain: GainNode, start: number, peak: number, decaySec: number): void {
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + decaySec);
}

type Tone = {
  start: number;
  frequency: number;
  type: OscillatorType;
  level: number;
  decaySec: number;
};

function makeNoise(context: BaseAudioContext): AudioBuffer {
  const length = Math.max(1, Math.floor(context.sampleRate * NOISE_SEC));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  let state = 0x2545f491;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[index] = state / 0x8000_0000 - 1;
  }
  return buffer;
}

export function createRevealSynth({ context, destination }: SoundOutput): RevealSounds {
  const master = context.createGain();
  master.gain.value = MASTER_GAIN;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -8;
  limiter.ratio.value = 12;
  master.connect(limiter);

  const noise = makeNoise(context);
  const live = new Set<AudioScheduledSourceNode>();

  // The output (on the TV, the never-closed voice engine) only holds the
  // synth while it sounds, so finished reveals leave nothing in its graph.
  let wired = false;
  const unwireWhenSilent = () => {
    if (wired && live.size === 0) {
      limiter.disconnect();
      wired = false;
    }
  };

  const track = (source: AudioScheduledSourceNode, start: number, stop: number) => {
    if (!wired) {
      limiter.connect(destination);
      wired = true;
    }
    live.add(source);
    source.addEventListener(
      'ended',
      () => {
        live.delete(source);
        unwireWhenSilent();
      },
      { once: true },
    );
    source.start(start);
    source.stop(stop);
  };

  const noiseHit = (start: number, level: number, filter: BiquadFilterNode, decaySec: number) => {
    const source = context.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    const gain = context.createGain();
    envelope(gain, start, level, decaySec);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    track(source, start, start + decaySec + 0.02);
  };

  const tone = ({ start, frequency, type, level, decaySec }: Tone) => {
    const osc = context.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, start);
    const gain = context.createGain();
    envelope(gain, start, level, decaySec);
    osc.connect(gain);
    gain.connect(master);
    track(osc, start, start + decaySec + 0.02);
  };

  const snare = (start: number, level: number) => {
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1900;
    band.Q.value = 0.8;
    noiseHit(start, level, band, 0.12);
    tone({ start, frequency: 185, type: 'triangle', level: level * 0.45, decaySec: 0.07 });
  };

  const brass = (start: number, midi: number, durationSec: number, level: number) => {
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 1.2;
    filter.frequency.setValueAtTime(500, start);
    filter.frequency.linearRampToValueAtTime(3400, start + 0.06);
    filter.frequency.linearRampToValueAtTime(1700, start + durationSec);
    const gain = context.createGain();
    const end = start + durationSec;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(level, start + 0.03);
    gain.gain.setValueAtTime(level * 0.8, Math.max(start + 0.04, end - 0.05));
    gain.gain.exponentialRampToValueAtTime(0.0001, end + 0.18);
    filter.connect(gain);
    gain.connect(master);
    for (const detuneCents of [-7, 7]) {
      const osc = context.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(midiHz(midi), start);
      osc.detune.value = detuneCents;
      osc.connect(filter);
      track(osc, start, end + 0.2);
    }
  };

  const bell = (start: number, midi: number, level: number) => {
    tone({ start, frequency: midiHz(midi), type: 'sine', level, decaySec: 1.2 });
    tone({
      start,
      frequency: midiHz(midi) * 2.76,
      type: 'sine',
      level: level * 0.25,
      decaySec: 0.5,
    });
  };

  const phrase = (start: number, notes: readonly Note[], level: number) => {
    for (const [midi, beat, beats] of notes) {
      brass(start + beat * BEAT_SEC, midi, beats * BEAT_SEC, level);
    }
  };

  const chord = (start: number, notes: readonly number[], beats: number, level: number) => {
    for (const midi of notes) {
      brass(start, midi, beats * BEAT_SEC, level / 2);
    }
  };

  const now = () => context.currentTime + 0.02;

  const stingers: Record<ScoreTier, (start: number) => void> = {
    perfect: (start) => {
      phrase(start, C_MAJOR_CALL, 0.22);
      chord(start + 6 * BEAT_SEC, C_MAJOR_CHORD, 4, 0.3);
      phrase(start, D_MAJOR_ANSWER, 0.22);
      chord(start + 17 * BEAT_SEC, D_MAJOR_CHORD, 8, 0.32);
      SPARKLE_NOTES.forEach((midi, index) => {
        bell(start + (17 + index) * BEAT_SEC, midi, 0.12);
        bell(start + (21 + index) * BEAT_SEC, midi, 0.08);
      });
      for (let pop = 0; pop < 6; pop++) {
        const crackle = context.createBiquadFilter();
        crackle.type = 'highpass';
        crackle.frequency.value = 2500;
        noiseHit(start + (18 + pop * 1.7) * BEAT_SEC, 0.18, crackle, 0.35);
      }
    },
    excellent: (start) => {
      phrase(start, C_MAJOR_CALL, 0.22);
      chord(start + 6 * BEAT_SEC, C_MAJOR_CHORD, 6, 0.3);
    },
    great: (start) => {
      phrase(start, C_MAJOR_CALL.slice(1), 0.2);
      chord(start + 5 * BEAT_SEC, C_MAJOR_CHORD.slice(0, 3), 4, 0.26);
    },
    good: (start) => {
      bell(start, 79, 0.2);
      bell(start + 1.2 * BEAT_SEC, 84, 0.2);
    },
    retry: (start) => {
      phrase(start, RETRY_NOTES, 0.12);
    },
  };

  return {
    drumRoll: (durationSec) => {
      const start = now();
      const end = start + Math.max(0, durationSec);
      let time = start;
      let stroke = 0;
      while (time < end) {
        const progress = (time - start) / Math.max(0.001, durationSec);
        const accent = stroke % 2 === 0 ? 1 : 0.82;
        snare(time, (0.16 + 0.5 * progress) * accent);
        time += 0.075 - 0.043 * progress;
        stroke++;
      }
    },
    slam: () => {
      const start = now();
      const kick = context.createOscillator();
      kick.type = 'sine';
      kick.frequency.setValueAtTime(150, start);
      kick.frequency.exponentialRampToValueAtTime(42, start + 0.3);
      const kickGain = context.createGain();
      envelope(kickGain, start, 0.9, 0.5);
      kick.connect(kickGain);
      kickGain.connect(master);
      track(kick, start, start + 0.55);

      const air = context.createBiquadFilter();
      air.type = 'highpass';
      air.frequency.value = 4500;
      noiseHit(start, 0.42, air, 1.8);
    },
    celebrate: (tier) => stingers[tier](now() + 0.12),
    stop: () => {
      for (const source of live) {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
      }
      live.clear();
      unwireWhenSilent();
    },
  };
}

/**
 * Sounds that build the synth on first use, so creating them has no side
 * effects and the first sound already plays on the real output.
 */
export function createLazyRevealSounds(getOutput: () => SoundOutput | null): RevealSounds {
  let synth: RevealSounds | null = null;
  const active = (): RevealSounds => {
    if (synth === null) {
      const output = getOutput();
      synth = output === null ? SILENT_REVEAL_SOUNDS : createRevealSynth(output);
    }
    return synth;
  };

  return {
    drumRoll: (durationSec) => active().drumRoll(durationSec),
    slam: () => active().slam(),
    celebrate: (tier) => active().celebrate(tier),
    stop: () => synth?.stop(),
  };
}
