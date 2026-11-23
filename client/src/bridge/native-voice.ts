import { z } from 'zod';

/**
 * The FireSong TV app's native voice output (`VoiceDoor` in
 * android/firesong-tv): a loopback WebSocket that plays 48 kHz stereo s16le
 * through Android's low-latency audio path. `window.FireSongVoice` exists
 * only inside the app; anywhere else both reads return null.
 */
const endpointSchema = z.object({
  version: z.literal(1),
  url: z.string().startsWith('ws://127.0.0.1:'),
  rate: z.number().int().positive(),
  channels: z.literal(2),
  format: z.literal('s16le'),
});

export type NativeVoiceEndpoint = z.infer<typeof endpointSchema>;

const statsSchema = z.object({
  open: z.boolean(),
  connected: z.boolean(),
  connections: z.number(),
  playedFrames: z.number(),
  underruns: z.number(),
  trimmedFrames: z.number(),
  overflowFrames: z.number(),
  receivedFrames: z.number(),
  fillMs: z.number(),
  marginMs: z.number(),
  outputLatencyMs: z.number().nullable(),
  burstFrames: z.number(),
  bufferFrames: z.number(),
  xruns: z.number(),
  peak: z.number(),
});

export type NativeVoiceStats = z.infer<typeof statsSchema>;

const call = (method: 'endpoint' | 'stats'): string | null => {
  const door: unknown = Reflect.get(window, 'FireSongVoice');
  if (typeof door !== 'object' || door === null) {
    return null;
  }
  const fn: unknown = Reflect.get(door, method);
  if (typeof fn !== 'function') {
    return null;
  }
  try {
    const text: unknown = Reflect.apply(fn, door, []);
    return typeof text === 'string' && text !== '' ? text : null;
  } catch {
    return null;
  }
};

const parse = <T>(schema: z.ZodType<T>, text: string | null): T | null => {
  if (text === null) {
    return null;
  }
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};

export const nativeVoiceEndpoint = (): NativeVoiceEndpoint | null =>
  parse(endpointSchema, call('endpoint'));

export const nativeVoiceStats = (): NativeVoiceStats | null => parse(statsSchema, call('stats'));
