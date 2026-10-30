import { PREVIEW_SCROLL_CHANNEL, PREVIEW_SCROLL_MAX, PREVIEW_SCROLL_REPORT_MS, PREVIEW_SCROLL_RESTORE_MS } from './preview-scroll-protocol';
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
// Runs inside the opaque sandbox before any user markup or script.
const PREVIEW_LINK_SCRIPT = String.raw`<script>(() => {
  const apply = Reflect.apply;
  const closest = Element.prototype.closest;
  const getAttribute = Element.prototype.getAttribute;
  const path = Event.prototype.composedPath;
  const prevent = Event.prototype.preventDefault;
  const stop = Event.prototype.stopImmediatePropagation;
  const button = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'button').get;
  const trim = String.prototype.trim;
  const startsWith = String.prototype.startsWith;
  const regexTest = RegExp.prototype.test;
  const absolute = /^https?:\/\//i;
  const NativeURL = URL;
  const protocol = Object.getOwnPropertyDescriptor(URL.prototype, 'protocol').get;
  const href = Object.getOwnPropertyDescriptor(URL.prototype, 'href').get;
  const open = window.open;
  const location = window.location;
  document.addEventListener('click', event => {
    let link = null;
    const nodes = apply(path, event, []);
    for (let index = 0; index < nodes.length; index++) {
      try { link = apply(closest, nodes[index], ['a[href],area[href]']); } catch { continue; }
      if (link) break;
    }
    if (!link) return;
    const value = apply(getAttribute, link, ['href']);
    if (typeof value !== 'string') return;
    const raw = apply(trim, value, []);
    apply(prevent, event, []);
    apply(stop, event, []);
    if (!event.isTrusted || apply(button, event, []) !== 0) return;
    if (apply(startsWith, raw, ['#'])) { location.hash = raw; return; }
    if (!apply(regexTest, absolute, [raw])) return;
    try {
      const url = new NativeURL(raw);
      const scheme = apply(protocol, url, []);
      if (scheme === 'http:' || scheme === 'https:') apply(open, window, [apply(href, url, []), '_blank', 'noopener,noreferrer']);
    } catch { /* Invalid URLs do not navigate. */ }
  }, true);
})();</script>`;
function previewScrollScript(documentId: string): string {
  return `<script>(() => {
    const channel = ${JSON.stringify(PREVIEW_SCROLL_CHANNEL)}, id = ${JSON.stringify(documentId)}, max = ${PREVIEW_SCROLL_MAX};
    const apply = Reflect.apply, keys = Object.keys, finite = Number.isFinite, isArray = Array.isArray;
    const min = Math.min, maxValue = Math.max, every = Array.prototype.every, includes = Array.prototype.includes;
    const timeout = window.setTimeout.bind(window), interval = window.setInterval.bind(window), clear = window.clearInterval.bind(window);
    const sourceGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'source').get;
    const dataGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data').get;
    const parent = window.parent, post = parent.postMessage, scrollTo = window.scrollTo;
    const descriptor = name => Object.getOwnPropertyDescriptor(window, name) || Object.getOwnPropertyDescriptor(Window.prototype, name);
    const xGetter = descriptor('scrollX')?.get, yGetter = descriptor('scrollY')?.get;
    const getPosition = () => ({ x: maxValue(0, min(max, xGetter ? apply(xGetter, window, []) : 0)), y: maxValue(0, min(max, yGetter ? apply(yGetter, window, []) : 0)) });
    const send = value => apply(post, parent, [value, '*']);
    let restored = false, requested = false, loaded = document.readyState === 'complete', userMoved = false, queued = false, desired = null;
    const report = kind => send({ channel, documentId: id, kind, ...getPosition() });
    const finish = () => {
      if (restored || !requested) return;
      if (!userMoved && desired) apply(scrollTo, window, [{ left: desired.x, top: desired.y, behavior: 'instant' }]);
      restored = true; report('restored');
    };
    const ready = () => { if (!restored) send({ channel, documentId: id, kind: 'ready' }); };
    document.addEventListener('DOMContentLoaded', ready, { once: true });
    window.addEventListener('load', () => { loaded = true; ready(); finish(); }, { once: true });
    const readyTimer = interval(ready, ${PREVIEW_SCROLL_REPORT_MS});
    timeout(() => clear(readyTimer), ${PREVIEW_SCROLL_RESTORE_MS});
    for (const kind of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(kind, event => { if (!restored && event.isTrusted) { userMoved = true; finish(); } }, { capture: true, passive: true });
    window.addEventListener('scroll', () => {
      if (!restored || queued) return;
      queued = true; timeout(() => { queued = false; report('position'); }, ${PREVIEW_SCROLL_REPORT_MS});
    }, { passive: true });
    window.addEventListener('message', event => {
      const source = apply(sourceGetter, event, []), data = apply(dataGetter, event, []);
      if (source !== parent || !data || typeof data !== 'object' || isArray(data)) return;
      const names = keys(data);
      if (data.channel !== channel || data.documentId !== id) return;
      if (data.kind === 'snapshot-request' && names.length === 4 && typeof data.requestId === 'string' && data.requestId.length <= 64 && apply(every, names, [name => apply(includes, ['channel','documentId','kind','requestId'], [name])])) {
        send({ channel, documentId: id, kind: 'snapshot', requestId: data.requestId, ...getPosition() });
      } else if (data.kind === 'restore' && !requested && names.length === 5 && apply(every, names, [name => apply(includes, ['channel','documentId','kind','x','y'], [name])]) && typeof data.x === 'number' && typeof data.y === 'number' && finite(data.x) && finite(data.y) && data.x >= 0 && data.y >= 0 && data.x <= max && data.y <= max) {
        requested = true; desired = { x: data.x, y: data.y };
        if (loaded) finish(); else timeout(finish, ${PREVIEW_SCROLL_RESTORE_MS});
      }
    });
  })();</script>`;
}
export function previewDocument(html: string, documentId?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta name="referrer" content="no-referrer">${PREVIEW_LINK_SCRIPT}${documentId ? previewScrollScript(documentId) : ""}</head><body>${html}</body></html>`;
}
export function previewRatioBounds(width: number): [number, number] {
  const usable = Math.max(1, width - 8);
  return [Math.max(30, 240 / usable * 100), Math.min(70, 100 - 240 / usable * 100)];
}
export function clampPreviewRatio(ratio: number, width: number): number {
  const [min, max] = previewRatioBounds(width);
  return Math.max(min, Math.min(max, ratio));
}
