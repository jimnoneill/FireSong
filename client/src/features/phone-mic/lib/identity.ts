import { z } from 'zod';

import {
  isMicSlot,
  isValidMicId,
  MAX_NAME_CHARS,
  MIC_IDENTITY_STORAGE_KEY,
  type MicSlot,
  type StoredMicIdentity,
} from '@/features/remote-mic/protocol';

/** The slice of `Storage` the phone page needs; tests pass an in-memory map. */
export type KeyValueStore = {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
};

/** Phone-local convenience: the singer name typed on the join card. */
export const SINGER_NAME_STORAGE_KEY = 'firesong.mic.name';

const RESUME_KEY_PATTERN = /^[0-9a-f]{32}$/;

const storedIdentitySchema = z.object({
  micId: z.string().refine(isValidMicId),
  resumeKey: z.string().regex(RESUME_KEY_PATTERN).optional(),
  slot: z.number().optional(),
});

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/**
 * The identity saved by the last `assign`. Anything malformed is ignored, so a
 * corrupted entry can never turn into a fatal `bad-hello`.
 */
export const readMicIdentity = (store: KeyValueStore): StoredMicIdentity | null => {
  const raw = store.get(MIC_IDENTITY_STORAGE_KEY);
  const parsed = storedIdentitySchema.safeParse(raw === null ? undefined : parseJson(raw));
  if (!parsed.success) {
    return null;
  }

  const { micId, resumeKey, slot } = parsed.data;
  return {
    micId,
    ...(resumeKey === undefined ? {} : { resumeKey }),
    ...(isMicSlot(slot) ? { slot } : {}),
  };
};

export const writeMicIdentity = (store: KeyValueStore, identity: StoredMicIdentity): void => {
  store.set(MIC_IDENTITY_STORAGE_KEY, JSON.stringify(identity));
};

export const forgetMicIdentity = (store: KeyValueStore): void => {
  store.remove(MIC_IDENTITY_STORAGE_KEY);
};

/** The stored identity, or a fresh `micId` that is saved straight away. */
export const ensureMicIdentity = (
  store: KeyValueStore,
  newMicId: () => string,
): StoredMicIdentity => {
  const stored = readMicIdentity(store);
  if (stored !== null) {
    return stored;
  }

  const identity: StoredMicIdentity = { micId: newMicId() };
  writeMicIdentity(store, identity);
  return identity;
};

/**
 * The slot to ask for in `hello`: the slot this page was assigned, else the
 * QR's slot, else the slot saved by an earlier visit.
 */
export const preferredSlot = (
  assigned: MicSlot | null,
  linkSlot: MicSlot | null,
  identity: StoredMicIdentity,
): MicSlot | undefined => assigned ?? linkSlot ?? identity.slot;

/**
 * A name the server accepts (1-32 characters, no control characters), or
 * `null` when nothing usable is left.
 */
export const normalizeSingerName = (input: string): string | null => {
  const cleaned = input.replace(/\p{Cc}/gu, '').trim();
  const name = Array.from(cleaned).slice(0, MAX_NAME_CHARS).join('').trim();
  return name === '' ? null : name;
};

export const readSingerName = (store: KeyValueStore): string =>
  normalizeSingerName(store.get(SINGER_NAME_STORAGE_KEY) ?? '') ?? '';

export const writeSingerName = (store: KeyValueStore, name: string | null): void => {
  if (name === null) {
    store.remove(SINGER_NAME_STORAGE_KEY);
    return;
  }
  store.set(SINGER_NAME_STORAGE_KEY, name);
};
