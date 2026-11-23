import { z } from 'zod';

/**
 * Where the FireSong TV app's native voice engine listens (`VoiceDoor` in
 * android/firesong-tv): a loopback WebSocket that speaks the mics protocol
 * (`native-mic-protocol.ts`). `window.FireSongVoice` exists only inside the
 * app; anywhere else, and in an app without the engine, the endpoint is null.
 */
const endpointSchema = z.object({
  version: z.literal(2),
  url: z.string().startsWith('ws://127.0.0.1:'),
  features: z.array(z.string()).refine((features) => features.includes('mics')),
});

export type NativeVoiceEndpoint = z.infer<typeof endpointSchema>;

const readEndpoint = (): string | null => {
  const door: unknown = Reflect.get(window, 'FireSongVoice');
  if (typeof door !== 'object' || door === null) {
    return null;
  }
  const endpoint: unknown = Reflect.get(door, 'endpoint');
  if (typeof endpoint !== 'function') {
    return null;
  }
  try {
    const text: unknown = Reflect.apply(endpoint, door, []);
    return typeof text === 'string' && text !== '' ? text : null;
  } catch {
    return null;
  }
};

export const nativeVoiceEndpoint = (): NativeVoiceEndpoint | null => {
  const text = readEndpoint();
  if (text === null) {
    return null;
  }
  try {
    const result = endpointSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};
