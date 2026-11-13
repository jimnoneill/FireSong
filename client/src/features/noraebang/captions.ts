import type { ScoreTier } from '@/features/remote-mic/protocol';
import type { TranslationKey } from '@/i18n';
import type { ClipLicense } from '@/types/firesong/ClipLicense';

export type TierCaptionKeys = {
  /** Korean caption, the same in every catalog. */
  korean: TranslationKey;
  /** Gloss in the interface language. */
  gloss: TranslationKey;
};

export const TIER_CAPTIONS: Readonly<Record<ScoreTier, TierCaptionKeys>> = {
  perfect: {
    korean: 'firesong.noraebang.tier.perfect.ko',
    gloss: 'firesong.noraebang.tier.perfect',
  },
  excellent: {
    korean: 'firesong.noraebang.tier.excellent.ko',
    gloss: 'firesong.noraebang.tier.excellent',
  },
  great: { korean: 'firesong.noraebang.tier.great.ko', gloss: 'firesong.noraebang.tier.great' },
  good: { korean: 'firesong.noraebang.tier.good.ko', gloss: 'firesong.noraebang.tier.good' },
  retry: { korean: 'firesong.noraebang.tier.retry.ko', gloss: 'firesong.noraebang.tier.retry' },
};

export const LICENSE_LABELS: Readonly<Record<ClipLicense, TranslationKey>> = {
  cc0: 'firesong.noraebang.license.cc0',
  'public-domain': 'firesong.noraebang.license.publicDomain',
  pixabay: 'firesong.noraebang.license.pixabay',
  pexels: 'firesong.noraebang.license.pexels',
  original: 'firesong.noraebang.license.original',
};
