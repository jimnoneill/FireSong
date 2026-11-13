import { z } from 'zod';

import type { ClipDirStatus } from '@/types/firesong/ClipDirStatus';
import type { ClipLicense } from '@/types/firesong/ClipLicense';
import type { NoraebangClip } from '@/types/firesong/NoraebangClip';
import type { NoraebangClips } from '@/types/firesong/NoraebangClips';

import { playbackAdapter } from './playback';
import { invoke } from './runtime';

export type { ClipDirStatus, ClipLicense, NoraebangClip, NoraebangClips };

const clipSchema = z.object({
  id: z.string(),
  path: z.string().min(1),
  title: z.string().optional(),
  source: z.string(),
  sourceUrl: z.string().optional(),
  author: z.string().optional(),
  license: z.enum(['cc0', 'public-domain', 'pixabay', 'pexels', 'original']),
  tags: z.array(z.string()),
  durationSec: z.number().optional(),
}) satisfies z.ZodType<NoraebangClip>;

const clipsSchema = z.object({
  status: z.enum([
    'ok',
    'missing',
    'not-a-directory',
    'symlink',
    'outside-media-roots',
    'inside-videos-dir',
  ]),
  clips: z.array(clipSchema),
  skipped: z.number(),
}) satisfies z.ZodType<NoraebangClips>;

/** The noraebang clip pool on the server, sorted by file name. */
export const listNoraebangClips = async (): Promise<NoraebangClips> =>
  clipsSchema.parse(await invoke<unknown>('list_noraebang_clips'));

/** A playable URL for a clip path from `listNoraebangClips`. */
export const noraebangClipUrl = async (clip: NoraebangClip): Promise<string> => {
  await playbackAdapter.init();
  return playbackAdapter.toMediaUrl(clip.path);
};
