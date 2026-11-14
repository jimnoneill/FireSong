/** A whole-token bucket that mirrors a server budget, such as "3, then one per 2 s". */
export type TokenBucket = {
  tokens: number;
  /** When `tokens` was last brought up to date, in ms. */
  updatedAt: number;
};

export type BucketRule = {
  burst: number;
  refillMs: number;
};

export const fullBucket = (rule: BucketRule, now: number): TokenBucket => ({
  tokens: rule.burst,
  updatedAt: now,
});

/** The bucket as it stands at `now`; partial refills carry over. */
export const bucketAt = (bucket: TokenBucket, rule: BucketRule, now: number): TokenBucket => {
  const elapsed = Math.max(0, now - bucket.updatedAt);
  const gained = Math.floor(elapsed / rule.refillMs);
  if (bucket.tokens + gained >= rule.burst) {
    return { tokens: rule.burst, updatedAt: now };
  }
  return { tokens: bucket.tokens + gained, updatedAt: bucket.updatedAt + gained * rule.refillMs };
};

/** Spends one token, or `null` when the bucket is empty at `now`. */
export const takeToken = (
  bucket: TokenBucket,
  rule: BucketRule,
  now: number,
): TokenBucket | null => {
  const current = bucketAt(bucket, rule, now);
  if (current.tokens < 1) {
    return null;
  }
  const updatedAt = current.tokens >= rule.burst ? now : current.updatedAt;
  return { tokens: current.tokens - 1, updatedAt };
};

/** When the next token arrives, or `null` while the bucket is full. */
export const nextTokenAt = (bucket: TokenBucket, rule: BucketRule, now: number): number | null => {
  const current = bucketAt(bucket, rule, now);
  return current.tokens >= rule.burst ? null : current.updatedAt + rule.refillMs;
};
