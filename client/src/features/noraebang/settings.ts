/**
 * Noraebang mode settings. They are client-local (localStorage), so neither
 * `AppConfig` nor its schema changes. The Fire TV app opens
 * `/?tv=1&mode=noraebang`; `?mode=classic` turns the mode off again. Both are
 * read once, when this module loads, before the router drops the query.
 */

import { useSyncExternalStore } from 'react';
import { z } from 'zod';

export const ECHO_PRESET_IDS = ['off', 'light', 'noraebang', 'hall'] as const;

export type EchoPresetId = (typeof ECHO_PRESET_IDS)[number];

export type NoraebangSettings = {
  /** Clips, wipe lyrics, hidden live score and the 0-100 reveal. */
  enabled: boolean;
  /** Korean tier captions (완벽해요! ...) above the English gloss. */
  koreanCaptions: boolean;
  /** Echo preset the TV voice engine applies to phone mics. */
  echoPreset: EchoPresetId;
};

export const DEFAULT_NORAEBANG_SETTINGS: NoraebangSettings = {
  enabled: false,
  koreanCaptions: true,
  echoPreset: 'noraebang',
};

export const NORAEBANG_SETTINGS_STORAGE_KEY = 'firesong.noraebang';

export type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

const echoPresetSchema = z.enum(ECHO_PRESET_IDS);

// Each field falls back on its own, so one bad value does not reset the rest.
const storedSettingsSchema = z.object({
  enabled: z.boolean().catch(DEFAULT_NORAEBANG_SETTINGS.enabled),
  koreanCaptions: z.boolean().catch(DEFAULT_NORAEBANG_SETTINGS.koreanCaptions),
  echoPreset: echoPresetSchema.catch(DEFAULT_NORAEBANG_SETTINGS.echoPreset),
});

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Stored settings over the defaults. Anything unreadable falls back to the defaults. */
export function parseStoredSettings(raw: string | null): NoraebangSettings {
  if (raw === null) {
    return DEFAULT_NORAEBANG_SETTINGS;
  }
  const parsed = storedSettingsSchema.safeParse(parseJson(raw));
  return parsed.success ? parsed.data : DEFAULT_NORAEBANG_SETTINGS;
}

function modeOverride(mode: string | null): Partial<NoraebangSettings> {
  if (mode === 'noraebang') {
    return { enabled: true };
  }
  return mode === 'classic' ? { enabled: false } : {};
}

function echoOverride(echo: string | null): Partial<NoraebangSettings> {
  const parsed = echoPresetSchema.safeParse(echo);
  return parsed.success ? { echoPreset: parsed.data } : {};
}

/**
 * Applies `?mode=noraebang|classic` and `?echo=<preset>`. Returns `null` when
 * the query changes nothing, so nothing is written back to storage.
 */
export function applyUrlOverrides(
  settings: NoraebangSettings,
  search: string,
): NoraebangSettings | null {
  const params = new URLSearchParams(search);
  const overrides = { ...modeOverride(params.get('mode')), ...echoOverride(params.get('echo')) };
  if (Object.keys(overrides).length === 0) {
    return null;
  }
  return { ...settings, ...overrides };
}

function browserStorage(): SettingsStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readStored(storage: SettingsStorage | null): NoraebangSettings {
  try {
    return parseStoredSettings(storage?.getItem(NORAEBANG_SETTINGS_STORAGE_KEY) ?? null);
  } catch {
    return DEFAULT_NORAEBANG_SETTINGS;
  }
}

function writeStored(storage: SettingsStorage | null, settings: NoraebangSettings): void {
  try {
    storage?.setItem(NORAEBANG_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode or a full quota: the setting still applies to this page.
  }
}

function initialSettings(): NoraebangSettings {
  const storage = browserStorage();
  const stored = readStored(storage);
  const search = typeof window === 'undefined' ? '' : window.location.search;
  const fromUrl = applyUrlOverrides(stored, search);
  if (fromUrl === null) {
    return stored;
  }
  writeStored(storage, fromUrl);
  return fromUrl;
}

let current = initialSettings();
const listeners = new Set<() => void>();

export function getNoraebangSettings(): NoraebangSettings {
  return current;
}

export function isNoraebangMode(): boolean {
  return current.enabled;
}

export function setNoraebangSettings(patch: Partial<NoraebangSettings>): void {
  current = { ...current, ...patch };
  writeStored(browserStorage(), current);
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeNoraebangSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useNoraebangSettings(): NoraebangSettings {
  return useSyncExternalStore(
    subscribeNoraebangSettings,
    getNoraebangSettings,
    getNoraebangSettings,
  );
}
