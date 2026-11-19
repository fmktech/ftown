import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, realpath, rename, rmdir, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const CHUNK_BYTES = 192 * 1024;
export const MAX_SNAPSHOT_BYTES = 64 * 1024 ** 3;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_ENTRIES = 1_000_000;
export const sha256 = () => createHash('sha256');

function unchanged(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.mode === right.mode;
}

export async function* readSnapshot(source: string, signal: AbortSignal): AsyncGenerator<Buffer> {
  const root = join(await realpath(dirname(source)), basename(source));
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const linux = process.platform === 'linux';
  let entries = 0;

  async function* walk(path: string, name: string, verifyParent: () => Promise<void>): AsyncGenerator<Buffer> {
    signal.throwIfAborted();
    await verifyParent();
    const before = await lstat(path, { bigint: true });
    const directory = before.isDirectory();
    if ((!directory && !before.isFile()) || (!name && !directory) || (before.mode & 0o6000n)) throw new Error();
    const file = await open(path, flags | (directory ? constants.O_DIRECTORY : 0));
    try {
      // Linux anchors descendants to the directory fd. Node on macOS has no
      // openat: these repeated checks catch ordinary renames, but a concurrent
      // local actor who can swap an ancestor out and back can race path lookup.
      const verify = async () => {
        await verifyParent();
        if (!unchanged(before, await lstat(path, { bigint: true })) || !unchanged(before, await file.stat({ bigint: true }))) throw new Error();
      };
      await verify();
      if (!directory && before.size > BigInt(MAX_SNAPSHOT_BYTES)) throw new Error();
      const size = Number(before.size);
      if (name) {
        entryPath(name);
        if (++entries > MAX_ENTRIES) throw new Error();
        const header = Buffer.from(JSON.stringify({ path: name, size: directory ? null : size }));
        const length = Buffer.alloc(4);
        length.writeUInt32BE(header.length);
        yield length;
        yield header;
      }
      if (directory) {
        const base = linux ? `/proc/self/fd/${file.fd}` : path;
        for await (const entry of await opendir(base, { encoding: 'buffer' as BufferEncoding })) {
          const raw = entry.name as unknown as Buffer;
          const child = raw.toString('utf8');
          if (!Buffer.from(child).equals(raw)) throw new Error();
          yield* walk(join(base, child), name ? `${name}/${child}` : child, linux ? async () => {} : verify);
        }
      } else {
        const digest = sha256();
        let remaining = size;
        if (remaining) {
          for await (const bytes of file.createReadStream({ autoClose: false, signal, start: 0, end: size - 1, highWaterMark: CHUNK_BYTES })) {
            digest.update(bytes);
            remaining -= bytes.length;
            yield bytes;
          }
        }
        if (remaining) throw new Error();
        await verify();
        yield digest.digest();
      }
      await verify();
    } finally {
      await file.close();
    }
  }

  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  let used = 0;
  try {
    async function* records(): AsyncGenerator<Buffer> {
      yield* walk(root, '', async () => {
        if (await realpath(dirname(root)) !== dirname(root)) throw new Error();
      });
      yield Buffer.alloc(4);
    }
    for await (const data of records()) {
      for (let offset = 0; offset < data.length;) {
        const size = data.copy(chunk, used, offset);
        used += size;
        offset += size;
        if (used === chunk.length) {
          yield chunk;
          used = 0;
        }
      }
    }
    if (used) yield chunk.subarray(0, used);
  } catch {
    signal.throwIfAborted();
    throw new Error('Cannot read a stable folder snapshot. Check source paths and file types.');
  }
}

export async function writeBytes(file: FileHandle, bytes: Buffer, position?: number): Promise<void> {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, position === undefined ? null : position + offset);
    if (!bytesWritten) throw new Error('Incomplete snapshot write');
    offset += bytesWritten;
  }
}

function entryPath(path: unknown): string {
  if (typeof path !== 'string' || Buffer.byteLength(path) > 4096 || /[\\\x00-\x1f\x7f]/.test(path)
    || Buffer.from(path).toString() !== path) throw new Error('Invalid snapshot path');
  const parts = path.split('/');
  if (parts.length > 128 || parts.some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255)) {
    throw new Error('Invalid snapshot path');
  }
  return path;
}

export async function makePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  // A setgid parent can propagate its bit even when mkdir receives mode 0700.
  await chmod(path, 0o700);
}

export async function extractSnapshot(spool: string, root: string, bytes: number, digest: string, signal: AbortSignal): Promise<number> {
  const input = await open(spool, constants.O_RDONLY | constants.O_NOFOLLOW);
  const archive = sha256();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let position = 0;
  let count = 0;
  const directories = [{ path: '', names: new Set<string>() }];
  async function verifyDirectory(): Promise<void> {
    const { path, names } = directories.pop()!;
    for await (const entry of await opendir(join(root, path))) {
      signal.throwIfAborted();
      if (!names.delete(entry.name)) throw new Error('Unexpected snapshot entry');
    }
    if (names.size) throw new Error('Snapshot entry missing');
  }
  async function read(length: number): Promise<Buffer> {
    signal.throwIfAborted();
    if (length > bytes - position) throw new Error('Truncated snapshot');
    const buffer = Buffer.allocUnsafe(length);
    for (let offset = 0; offset < length;) {
      const { bytesRead } = await input.read(buffer, offset, length - offset, position);
      if (!bytesRead) throw new Error('Truncated snapshot');
      offset += bytesRead;
      position += bytesRead;
    }
    archive.update(buffer);
    return buffer;
  }

  try {
    for (;;) {
      const length = (await read(4)).readUInt32BE();
      if (!length) break;
      if (length > MAX_HEADER_BYTES || ++count > MAX_ENTRIES) throw new Error('Snapshot entry limit exceeded');
      const { path: rawPath, size } = JSON.parse(decoder.decode(await read(length)));
      const path = entryPath(rawPath);
      const slash = path.lastIndexOf('/');
      const parent = slash < 0 ? '' : path.slice(0, slash);
      while (directories.length > 1 && directories.at(-1)!.path !== parent) await verifyDirectory();
      const directory = directories.at(-1)!;
      const name = path.slice(slash + 1);
      if (directory.path !== parent || directory.names.has(name)) throw new Error('Invalid snapshot entry order');
      directory.names.add(name);
      const target = join(root, path);
      if (size === null) {
        await makePrivateDirectory(target);
        directories.push({ path, names: new Set() });
        continue;
      }
      if (!Number.isSafeInteger(size) || size < 0 || size > bytes - position - 32) throw new Error('Invalid snapshot file size');
      // The private tree contains only entries created here, and exclusive creates catch duplicates
      // and collisions on case-insensitive or Unicode-normalizing filesystems.
      const output = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
      try {
        await output.chmod(0o600);
        for (let remaining = size; remaining > 0;) {
          const block = await read(Math.min(CHUNK_BYTES, remaining));
          await writeBytes(output, block);
          remaining -= block.length;
        }
        const expected = await read(32);
        const actual = sha256();
        let written = 0;
        for await (const block of output.createReadStream({ start: 0, autoClose: false, signal })) {
          actual.update(block);
          written += block.length;
        }
        if (written !== size || !actual.digest().equals(expected)) throw new Error('Snapshot file verification failed');
      } finally {
        await output.close();
      }
    }
    if (position !== bytes || (await input.stat()).size !== bytes || archive.digest('hex') !== digest) throw new Error('Unexpected snapshot data');
    while (directories.length) await verifyDirectory();
    return count;
  } finally {
    await input.close();
  }
}

export async function installSnapshot(source: string, dest: string, signal: AbortSignal,
  onReserve?: (reserved: BigIntStats) => Promise<void>): Promise<void> {
  signal.throwIfAborted();
  let reserved: BigIntStats | undefined;
  try {
    await mkdir(dest, { mode: 0o700 });
    reserved = await lstat(dest, { bigint: true });
    await onReserve?.(reserved);
    // mkdir refuses existing paths. Node has no exclusive rename flag, so
    // a local actor who can replace our empty reservation between the check
    // and rename can still race this step. The caller checks the parent trust.
    if (!unchanged(reserved, await lstat(dest, { bigint: true }))) throw new Error();
    signal.throwIfAborted();
    await rename(source, dest);
  } catch {
    if (reserved && await lstat(dest, { bigint: true }).then(info => unchanged(reserved!, info), () => false)) {
      await rmdir(dest).catch(() => {});
    }
    throw new Error('Exclusive install failed');
  }
}
