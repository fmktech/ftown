import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PREVIEW_CHUNK_BYTES, PREVIEW_MAX_BYTES, PREVIEW_MAX_CONCURRENT_READS } from './preview-protocol.js';
import type { PreviewUnavailableReason, SessionPreviewChunk, SessionPreviewDescriptor, SessionPreviewSource, SessionPreviewStatus } from './preview-protocol.js';
import type { Session } from './types.js';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const revisionPattern = /^[0-9a-f]{64}$/;
const safePath = (s: string) => s.length > 0 && Buffer.byteLength(s, 'utf8') <= 4096 && !s.includes('\0');
export const validPreviewId = (s: unknown): s is string => typeof s === 'string' && idPattern.test(s);
export const validRevision = (s: unknown): s is string => typeof s === 'string' && revisionPattern.test(s);

export class PreviewError extends Error {
  constructor(readonly reason: PreviewUnavailableReason) { super('Preview unavailable'); }
}
function invalid(): never { throw new PreviewError('invalid_file'); }
function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
async function validatePaths(workingDir: string | undefined, source: SessionPreviewSource): Promise<void> {
  if (!workingDir || !safePath(workingDir) || !safePath(source.root) || !safePath(source.filePath)
    || !isAbsolute(workingDir) || !isAbsolute(source.root) || !isAbsolute(source.filePath)
    || resolve(source.root) !== source.root || resolve(source.filePath) !== source.filePath
    || !contained(source.root, source.filePath)) invalid();
  const rootInfo = await lstat(workingDir);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(workingDir) !== source.root) invalid();
  const rootCanonical = await lstat(source.root);
  if (!rootCanonical.isDirectory() || rootCanonical.isSymbolicLink()) invalid();
  const parts = relative(source.root, source.filePath).split(sep);
  let current = source.root;
  for (let i = 0; i < parts.length; i++) {
    current = resolve(current, parts[i]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())) invalid();
  }
  if (await realpath(source.filePath) !== source.filePath) invalid();
}
function reason(error: unknown): PreviewUnavailableReason {
  if (error instanceof PreviewError) return error.reason;
  if (error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return 'missing';
  return 'unavailable';
}
function registration(session: Session, id: string): SessionPreviewSource | null {
  const source = session.previewSource;
  if (!session.preview || !source || session.preview.id !== id || source.id !== id || source.version !== 1) return null;
  return source;
}
export async function preparePreview(session: Session, path: unknown): Promise<{ preview: SessionPreviewDescriptor; previewSource: SessionPreviewSource }> {
  if (typeof path !== 'string' || !safePath(path) || !isAbsolute(path) || resolve(path) !== path || !session.workingDir) invalid();
  const fileName = basename(path);
  if (!fileName || Buffer.byteLength(fileName, 'utf8') > 255 || /[\u0000-\u001f\u007f-\u009f]/u.test(fileName) || !['.html', '.htm'].includes(extname(fileName).toLowerCase())) invalid();
  try {
    const root = await realpath(session.workingDir);
    const requestedRoot = resolve(session.workingDir);
    if (!contained(requestedRoot, path)) invalid();
    const filePath = resolve(root, relative(requestedRoot, path));
    const preview: SessionPreviewDescriptor = { id: randomUUID(), fileName };
    const previewSource: SessionPreviewSource = { version: 1, id: preview.id, root, filePath };
    await validatePaths(session.workingDir, previewSource);
    const info = await lstat(filePath);
    if (info.size > PREVIEW_MAX_BYTES) throw new PreviewError('too_large');
    return { preview, previewSource };
  } catch (error) { throw new PreviewError(reason(error)); }
}

type Snapshot = { bytes: Buffer; revision: string };
export class SessionPreviewReader {
  private active = 0;
  protected openFile(path: string) { return open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  protected initialStat(handle: FileHandle) { return handle.stat(); }
  async read(session: Session, source: SessionPreviewSource): Promise<Snapshot> {
    if (this.active >= PREVIEW_MAX_CONCURRENT_READS) throw new PreviewError('unavailable');
    this.active++;
    try {
      await validatePaths(session.workingDir, source);
      const handle = await this.openFile(source.filePath);
      try {
        const before = await this.initialStat(handle);
        if (!before.isFile()) invalid();
        if (before.size > PREVIEW_MAX_BYTES) throw new PreviewError('too_large');
        const buffer = Buffer.alloc(PREVIEW_MAX_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > PREVIEW_MAX_BYTES) throw new PreviewError('too_large');
        const after = await handle.stat();
        const current = await lstat(source.filePath);
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || length !== after.size) throw new PreviewError('unavailable');
        if (current.isSymbolicLink() || !current.isFile() || current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) throw new PreviewError('unavailable');
        const bytes = buffer.subarray(0, length);
        try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new PreviewError('invalid_utf8'); }
        return { bytes, revision: createHash('sha256').update(bytes).digest('hex') };
      } finally { await handle.close(); }
    } catch (error) { throw new PreviewError(reason(error)); }
    finally { this.active--; }
  }
}
export function previewStatus(id: string, snapshot: Snapshot, knownRevision?: string): SessionPreviewStatus {
  return { state: snapshot.revision === knownRevision ? 'unchanged' : 'ready', previewId: id, revision: snapshot.revision, totalBytes: snapshot.bytes.length };
}
export function previewChunk(id: string, snapshot: Snapshot, revision: string, offset: number): SessionPreviewChunk {
  if (snapshot.revision !== revision) return { state: 'stale_revision' };
  const totalBytes = snapshot.bytes.length;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % PREVIEW_CHUNK_BYTES !== 0 || (totalBytes === 0 ? offset !== 0 : offset >= totalBytes)) throw new PreviewError('invalid_file');
  const chunk = snapshot.bytes.subarray(offset, offset + PREVIEW_CHUNK_BYTES);
  return { state: 'chunk', previewId: id, revision, totalBytes, offset, dataBase64: chunk.toString('base64'), done: offset + chunk.length === totalBytes };
}
export function currentPreview(session: Session, id: string): SessionPreviewSource | null { return registration(session, id); }
