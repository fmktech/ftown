/** Untrusted UI hints only. Never carry chat, commands, or credentials. */
export const PREVIEW_SCROLL_CHANNEL = 'ftown-preview-scroll-v1';
/**
 * Child→parent external-link request. The URL originates from untrusted preview
 * HTML and is NOT proof of a trusted click, so the parent must never open it
 * directly — it shows a user confirmation and opens only on that user action.
 * A `switch-file` request asks the parent to select another registered file
 * by basename; the parent switches its own selector, never the frame content.
 */
export const PREVIEW_LINK_CHANNEL = 'ftown-preview-link-v1';
export type PreviewLinkMessage =
  | { channel: typeof PREVIEW_LINK_CHANNEL; kind: 'open-link'; url: string }
  | { channel: typeof PREVIEW_LINK_CHANNEL; kind: 'switch-file'; fileName: string };
export const PREVIEW_SCROLL_MAX = 10_000_000;
export const PREVIEW_SCROLL_REPORT_MS = 100;
export const PREVIEW_SCROLL_SNAPSHOT_MS = 100;
export const PREVIEW_SCROLL_RESTORE_MS = 500;
export interface PreviewScrollPosition { x: number; y: number }
export type PreviewScrollChildMessage =
  | { channel: typeof PREVIEW_SCROLL_CHANNEL; documentId: string; kind: 'ready' }
  | ({ channel: typeof PREVIEW_SCROLL_CHANNEL; documentId: string; kind: 'position' | 'restored' } & PreviewScrollPosition)
  | ({ channel: typeof PREVIEW_SCROLL_CHANNEL; documentId: string; kind: 'snapshot'; requestId: string } & PreviewScrollPosition);
export type PreviewScrollParentMessage =
  | ({ channel: typeof PREVIEW_SCROLL_CHANNEL; documentId: string; kind: 'restore' } & PreviewScrollPosition)
  | { channel: typeof PREVIEW_SCROLL_CHANNEL; documentId: string; kind: 'snapshot-request'; requestId: string };

/**
 * Scroll state is keyed per file by the owner key: the JSON tuple
 * [userId, bridgeId, sessionId, previewId, fileId]. The file id keeps each
 * registered file's position independent within the same session.
 */
export interface PreviewScrollOwner { userId: string; bridgeId: string; sessionId: string; previewId: string; fileId: string }
export function previewScrollOwnerKey(owner: PreviewScrollOwner): string {
  return JSON.stringify([owner.userId, owner.bridgeId, owner.sessionId, owner.previewId, owner.fileId]);
}
export function parsePreviewScrollOwnerKey(key: string): PreviewScrollOwner | null {
  let parts: unknown;
  try { parts = JSON.parse(key); } catch { return null; }
  if (!Array.isArray(parts)) return null;
  const values = parts as unknown[];
  if (values.length !== 5 || !values.every(value => typeof value === 'string')) return null;
  const [userId, bridgeId, sessionId, previewId, fileId] = values as [string, string, string, string, string];
  return { userId, bridgeId, sessionId, previewId, fileId };
}

/** Shape-only validation of an untrusted link-channel message. */
export function parsePreviewLinkMessage(value: unknown): PreviewLinkMessage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.channel !== PREVIEW_LINK_CHANNEL) return null;
  const keys = Object.keys(data);
  if (data.kind === 'open-link') {
    if (keys.length !== 3 || typeof data.url !== 'string') return null;
    return { channel: PREVIEW_LINK_CHANNEL, kind: 'open-link', url: data.url };
  }
  if (data.kind === 'switch-file') {
    if (keys.length !== 3 || typeof data.fileName !== 'string' || data.fileName.length === 0 || data.fileName.length > 255) return null;
    return { channel: PREVIEW_LINK_CHANNEL, kind: 'switch-file', fileName: data.fileName };
  }
  return null;
}
