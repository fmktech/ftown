/** Untrusted UI hints only. Never carry chat, commands, or credentials. */
export const PREVIEW_SCROLL_CHANNEL = 'ftown-preview-scroll-v1';
/**
 * Child→parent external-link request. The URL originates from untrusted preview
 * HTML and is NOT proof of a trusted click, so the parent must never open it
 * directly — it shows a user confirmation and opens only on that user action.
 */
export const PREVIEW_LINK_CHANNEL = 'ftown-preview-link-v1';
export type PreviewLinkMessage = { channel: typeof PREVIEW_LINK_CHANNEL; kind: 'open-link'; url: string };
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
