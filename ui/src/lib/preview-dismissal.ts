import type { SessionPreviewDescriptor } from '../../../bridge/src/preview-protocol';

/**
 * Which session previews the owner closed, remembered per browser.
 *
 * The map holds one entry per session: `sessionKey -> revision key of the preview that was closed`.
 * A revision key covers the registration id and its file ids, so a preview the agent registers
 * anew (or changes) has a different key and shows again. Reopening deletes the entry.
 *
 * Storage is best effort: every access is guarded, and when it is unavailable the in-memory map
 * still works for the current page.
 */
export const PREVIEW_DISMISSAL_STORAGE_KEY = 'ftown.previewDismissed.v1';
const MAX_ENTRIES = 200;

export type DismissedPreviews = Record<string, string>;

export function previewRevisionKey(descriptor: SessionPreviewDescriptor): string {
  return JSON.stringify([descriptor.id, descriptor.files.map(file => file.id)]);
}

export function isPreviewDismissed(dismissed: DismissedPreviews, sessionKey: string, descriptor: SessionPreviewDescriptor): boolean {
  return dismissed[sessionKey] === previewRevisionKey(descriptor);
}

export function withPreviewDismissed(dismissed: DismissedPreviews, sessionKey: string, descriptor: SessionPreviewDescriptor, value: boolean): DismissedPreviews {
  const next = { ...dismissed };
  if (value) next[sessionKey] = previewRevisionKey(descriptor);
  else delete next[sessionKey];
  return next;
}

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Reads the remembered map; anything unreadable or malformed reads as nothing dismissed. */
export function readDismissedPreviews(): DismissedPreviews {
  try {
    const raw = storage()?.getItem(PREVIEW_DISMISSAL_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: DismissedPreviews = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') result[key] = value;
    return result;
  } catch {
    return {};
  }
}

/** Writes the map, keeping the most recently closed sessions when it grows past the cap. Failures are ignored. */
export function writeDismissedPreviews(dismissed: DismissedPreviews): void {
  try {
    const entries = Object.entries(dismissed);
    const kept = Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_ENTRIES)));
    storage()?.setItem(PREVIEW_DISMISSAL_STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Quota, blocked or disabled storage: the in-memory map still applies for this page.
  }
}
