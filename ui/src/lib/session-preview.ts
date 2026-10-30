import { PREVIEW_CHUNK_BYTES, PREVIEW_MAX_BYTES, type SessionPreviewDescriptor, type SessionPreviewStatus, type PreviewUnavailableReason } from '../../../bridge/src/preview-protocol';

const revisionPattern = /^[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasons: PreviewUnavailableReason[] = ['missing', 'too_large', 'invalid_utf8', 'invalid_file', 'unavailable'];
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const size = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= PREVIEW_MAX_BYTES;
export function isPreviewDescriptor(value: unknown): value is SessionPreviewDescriptor {
  if (!record(value) || typeof value.id !== 'string' || !uuidPattern.test(value.id) || typeof value.fileName !== 'string') return false;
  return value.fileName.length > 0 && new TextEncoder().encode(value.fileName).length <= 255 && !/[\x00-\x1f\x7f-\x9f/\\]/.test(value.fileName) && value.fileName !== '.' && value.fileName !== '..';
}
export function parseStatus(value: unknown, previewId: string): SessionPreviewStatus {
  if (!record(value)) throw new Error('Invalid preview response');
  if (value.state === 'unregistered') return { state: 'unregistered' };
  if (value.previewId !== previewId) throw new Error('Invalid preview response');
  if (value.state === 'unavailable' && typeof value.reason === 'string' && reasons.includes(value.reason as PreviewUnavailableReason)) return { state: 'unavailable', previewId, reason: value.reason as PreviewUnavailableReason };
  if ((value.state === 'ready' || value.state === 'unchanged') && typeof value.revision === 'string' && revisionPattern.test(value.revision) && size(value.totalBytes)) return { state: value.state, previewId, revision: value.revision, totalBytes: value.totalBytes };
  throw new Error('Invalid preview response');
}
export function parseChunk(value: unknown, previewId: string, revision: string, totalBytes: number, offset: number): { state: 'stale_revision' } | { state: 'unavailable'; reason: PreviewUnavailableReason } | { state: 'chunk'; bytes: Uint8Array; done: boolean } {
  if (!record(value)) throw new Error('Invalid preview chunk');
  if (value.state === 'stale_revision') return { state: 'stale_revision' };
  if (value.previewId !== previewId) throw new Error('Invalid preview chunk');
  if (value.state === 'unavailable' && typeof value.reason === 'string' && reasons.includes(value.reason as PreviewUnavailableReason)) return { state: 'unavailable', reason: value.reason as PreviewUnavailableReason };
  if (value.state !== 'chunk' || value.revision !== revision || value.totalBytes !== totalBytes || value.offset !== offset || typeof value.dataBase64 !== 'string' || typeof value.done !== 'boolean' || value.dataBase64.length > Math.ceil(PREVIEW_CHUNK_BYTES / 3) * 4) throw new Error('Invalid preview chunk');
  let decoded: string;
  try { decoded = atob(value.dataBase64); } catch { throw new Error('Invalid preview chunk'); }
  if (btoa(decoded) !== value.dataBase64) throw new Error('Invalid preview chunk');
  const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
  const expected = Math.min(PREVIEW_CHUNK_BYTES, totalBytes - offset);
  if (bytes.length !== expected || value.done !== (offset + bytes.length === totalBytes)) throw new Error('Invalid preview chunk');
  return { state: 'chunk', bytes, done: value.done };
}
export async function verifyPreview(bytes: Uint8Array, revision: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
  if (Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') !== revision) throw new Error('Invalid preview digest');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
export const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; media-src 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export function previewDocument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta name="referrer" content="no-referrer"></head><body>${html}</body></html>`;
}
export function previewRatioBounds(width: number): [number, number] {
  const usable = Math.max(1, width - 8);
  return [Math.max(30, 240 / usable * 100), Math.min(70, 100 - 240 / usable * 100)];
}
export function clampPreviewRatio(ratio: number, width: number): number {
  const [min, max] = previewRatioBounds(width);
  return Math.max(min, Math.min(max, ratio));
}
