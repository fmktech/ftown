import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PREVIEW_CHUNK_BYTES, PREVIEW_MAX_BYTES, PREVIEW_MAX_CONCURRENT_READS, PREVIEW_MAX_FILES, previewKindForPath } from './preview-protocol.js';
import type { PreviewUnavailableReason, SessionPreviewChunk, SessionPreviewDescriptor, SessionPreviewSource, SessionPreviewStatus } from './preview-protocol.js';
import type { Session } from './types.js';

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const revisionPattern = /^[0-9a-f]{64}$/;
const safePath = (s: string) => s.length > 0 && Buffer.byteLength(s, 'utf8') <= 4096 && !s.includes('\0');
export const validPreviewId = (s: unknown): s is string => typeof s === 'string' && idPattern.test(s);
export const validFileId = (s: unknown): s is string => typeof s === 'string' && idPattern.test(s);
export const validRevision = (s: unknown): s is string => typeof s === 'string' && revisionPattern.test(s);

export class PreviewError extends Error {
  constructor(readonly reason: PreviewUnavailableReason, detail?: string) { super(detail ?? 'Preview unavailable'); }
}
function invalid(detail?: string): never { throw new PreviewError('invalid_file', detail); }
function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
function validFileName(fileName: string): boolean {
  return fileName.length > 0 && Buffer.byteLength(fileName, 'utf8') <= 255 && !/[\u0000-\u001f\u007f-\u009f]/u.test(fileName);
}
async function validatePaths(workingDir: string | undefined, source: SessionPreviewSource): Promise<void> {
  if (!workingDir || !safePath(workingDir) || !safePath(source.root) || !isAbsolute(workingDir) || !isAbsolute(source.root)
    || resolve(source.root) !== source.root) invalid();
  const rootInfo = await lstat(workingDir);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(workingDir) !== source.root) invalid();
  const rootCanonical = await lstat(source.root);
  if (!rootCanonical.isDirectory() || rootCanonical.isSymbolicLink()) invalid();
  for (const entry of source.files) {
    if (!safePath(entry.filePath) || !isAbsolute(entry.filePath) || resolve(entry.filePath) !== entry.filePath
      || !contained(source.root, entry.filePath)) invalid();
    const parts = relative(source.root, entry.filePath).split(sep);
    let current = source.root;
    for (let i = 0; i < parts.length; i++) {
      current = resolve(current, parts[i]);
      const info = await lstat(current);
      if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())) invalid();
    }
    if (await realpath(entry.filePath) !== entry.filePath) invalid();
  }
}
function reason(error: unknown): PreviewUnavailableReason {
  if (error instanceof PreviewError) return error.reason;
  if (error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return 'missing';
  return 'unavailable';
}
function registration(session: Session, id: string): SessionPreviewSource | null {
  const source = session.previewSource;
  const descriptor = session.preview;
  if (!descriptor || !source || descriptor.id !== id || source.id !== id || source.version !== 2) return null;
  if (!Array.isArray(descriptor.files) || !Array.isArray(source.files)) return null;
  return source;
}
export async function preparePreview(session: Session, paths: unknown): Promise<{ preview: SessionPreviewDescriptor; previewSource: SessionPreviewSource }> {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > PREVIEW_MAX_FILES || !session.workingDir) invalid();
  for (const path of paths) {
    if (typeof path !== 'string' || !safePath(path) || !isAbsolute(path) || resolve(path) !== path) invalid();
  }
  const entries: { path: string; fileName: string; kind: NonNullable<ReturnType<typeof previewKindForPath>> }[] = [];
  const seen = new Set<string>();
  for (const path of paths as string[]) {
    const fileName = basename(path);
    if (!validFileName(fileName)) invalid();
    const kind = previewKindForPath(fileName);
    if (!kind) invalid();
    if (seen.has(fileName)) invalid(`duplicate basename: ${fileName}`);
    seen.add(fileName);
    entries.push({ path, fileName, kind });
  }
  try {
    const root = await realpath(session.workingDir);
    const requestedRoot = resolve(session.workingDir);
    const resolved: { id: string; filePath: string }[] = [];
    for (const entry of entries) {
      if (!contained(requestedRoot, entry.path)) invalid();
      resolved.push({ id: randomUUID(), filePath: resolve(root, relative(requestedRoot, entry.path)) });
    }
    const preview: SessionPreviewDescriptor = {
      id: randomUUID(),
      files: entries.map((entry, i) => ({ id: resolved[i].id, fileName: entry.fileName, kind: entry.kind })),
    };
    const previewSource: SessionPreviewSource = { version: 2, id: preview.id, root, files: resolved };
    await validatePaths(session.workingDir, previewSource);
    for (const entry of resolved) {
      const info = await lstat(entry.filePath);
      if (info.size > PREVIEW_MAX_BYTES) throw new PreviewError('too_large');
    }
    return { preview, previewSource };
  } catch (error) {
    if (error instanceof PreviewError) throw error;
    throw new PreviewError(reason(error));
  }
}

type Snapshot = { bytes: Buffer; revision: string };
export class SessionPreviewReader {
  private active = 0;
  protected openFile(path: string) { return open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  protected initialStat(handle: FileHandle) { return handle.stat(); }
  async read(session: Session, source: SessionPreviewSource, fileId: string): Promise<Snapshot> {
    if (this.active >= PREVIEW_MAX_CONCURRENT_READS) throw new PreviewError('unavailable');
    this.active++;
    try {
      const entry = source.files.find(file => file.id === fileId);
      if (!entry) throw new PreviewError('invalid_file');
      const filePath = entry.filePath;
      await validatePaths(session.workingDir, source);
      const handle = await this.openFile(filePath);
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
        const current = await lstat(filePath);
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
export function previewStatus(id: string, fileId: string, snapshot: Snapshot, knownRevision?: string): SessionPreviewStatus {
  return { state: snapshot.revision === knownRevision ? 'unchanged' : 'ready', previewId: id, fileId, revision: snapshot.revision, totalBytes: snapshot.bytes.length };
}
export function previewChunk(id: string, fileId: string, snapshot: Snapshot, revision: string, offset: number): SessionPreviewChunk {
  if (snapshot.revision !== revision) return { state: 'stale_revision' };
  const totalBytes = snapshot.bytes.length;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % PREVIEW_CHUNK_BYTES !== 0 || (totalBytes === 0 ? offset !== 0 : offset >= totalBytes)) throw new PreviewError('invalid_file');
  const chunk = snapshot.bytes.subarray(offset, offset + PREVIEW_CHUNK_BYTES);
  return { state: 'chunk', previewId: id, fileId, revision, totalBytes, offset, dataBase64: chunk.toString('base64'), done: offset + chunk.length === totalBytes };
}
export function currentPreview(session: Session, id: string): SessionPreviewSource | null { return registration(session, id); }
