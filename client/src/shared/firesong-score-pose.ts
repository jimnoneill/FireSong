import sheepishUrl from '@/assets/images/firesong-score-50s.webp';
import winkingUrl from '@/assets/images/firesong-score-80.webp';
import grinningUrl from '@/assets/images/firesong-score-90.webp';
import cheeringUrl from '@/assets/images/firesong-score-100.webp';
import cryingUrl from '@/assets/images/firesong-score-low.webp';
import type { TranslationKey } from '@/i18n';

export type ScorePose = {
  readonly url: string;
  readonly alt: TranslationKey;
};

/**
 * The FireSong mascot's reaction to a 0-100 display score, for the TV reveal
 * and the phone's result card. Presentation only: these bands are not the
 * score tiers.
 */
export function scorePoseFor(displayScore: number): ScorePose {
  if (displayScore >= 100) {
    return { url: cheeringUrl, alt: 'firesong.scorePose.cheering' };
  }
  if (displayScore >= 90) {
    return { url: grinningUrl, alt: 'firesong.scorePose.grinning' };
  }
  // The winking pose holds an "80" sign, so it only fits the 80s.
  if (displayScore >= 80) {
    return { url: winkingUrl, alt: 'firesong.scorePose.winking' };
  }
  if (displayScore >= 50) {
    return { url: sheepishUrl, alt: 'firesong.scorePose.sheepish' };
  }
  return { url: cryingUrl, alt: 'firesong.scorePose.crying' };
}
