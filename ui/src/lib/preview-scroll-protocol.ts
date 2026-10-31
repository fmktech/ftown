/** Untrusted UI hints only. Never carry chat, commands, URLs, or credentials. */
export const PREVIEW_SCROLL_CHANNEL = 'ftown-preview-scroll-v1';
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
