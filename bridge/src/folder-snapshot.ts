import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const CHUNK_BYTES = 192 * 1024;
export const MAX_SNAPSHOT_BYTES = 64 * 1024 ** 3;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_ENTRIES = 1_000_000;
export const sha256 = () => createHash('sha256');

// Python supplies descriptor-relative open on both macOS and Linux. Opening every component
// with O_NOFOLLOW prevents a concurrent rename from redirecting traversal through a symlink.
const SOURCE = String.raw`
import hashlib, json, os, stat, struct, sys
out = sys.stdout.buffer
flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
count = 0
def identity(st):
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)
def walk(parent, prefix, depth):
    global count
    before = os.fstat(parent)
    with os.scandir(parent) as entries:
        for entry in entries:
            name = entry.name
            path = prefix + name
            count += 1
            if count > 1000000 or depth > 128 or len(name.encode()) > 255 or len(path.encode()) > 4096 or '\\' in name or any(ord(c) < 32 or ord(c) == 127 for c in name):
                raise ValueError()
            listed = entry.stat(follow_symlinks=False)
            if not (stat.S_ISREG(listed.st_mode) or stat.S_ISDIR(listed.st_mode)) or listed.st_mode & 0o6000:
                raise ValueError()
            fd = os.open(name, flags | (os.O_DIRECTORY if stat.S_ISDIR(listed.st_mode) else 0), dir_fd=parent)
            try:
                info = os.fstat(fd)
                if identity(listed) != identity(info) or info.st_mode != listed.st_mode:
                    raise ValueError()
                directory = stat.S_ISDIR(info.st_mode)
                header = json.dumps(dict(path=path, size=None if directory else info.st_size), ensure_ascii=False).encode()
                out.write(struct.pack('>I', len(header)))
                out.write(header)
                if directory:
                    walk(fd, path + '/', depth + 1)
                else:
                    digest = hashlib.sha256()
                    remaining = info.st_size
                    while remaining:
                        block = os.read(fd, min(remaining, 131072))
                        if not block:
                            raise ValueError()
                        out.write(block)
                        digest.update(block)
                        remaining -= len(block)
                    out.write(digest.digest())
                if identity(info) != identity(os.fstat(fd)):
                    raise ValueError()
            finally:
                os.close(fd)
    if identity(before) != identity(os.fstat(parent)):
        raise ValueError()

root = os.open('/', flags | os.O_DIRECTORY)
for part in sys.argv[1].split('/')[1:]:
    fd = os.open(part, flags | os.O_DIRECTORY, dir_fd=root)
    os.close(root)
    root = fd
if os.fstat(root).st_mode & 0o6000:
    raise ValueError()
walk(root, '', 1)
out.write(b'\0' * 4)
`;

// Use the OS's exclusive directory rename. A check followed by fs.rename can overwrite
// an empty directory created after the check.
const INSTALL = String.raw`
import ctypes, os, sys
lib = ctypes.CDLL(None, use_errno=True)
source, dest = map(os.fsencode, sys.argv[1:])
if sys.platform.startswith('linux'):
    result = lib.renameat2(-100, source, -100, dest, 1)
elif sys.platform == 'darwin':
    result = lib.renamex_np(source, dest, 4)
else:
    sys.exit(1)
sys.exit(0 if result == 0 else 1)
`;

function python(script: string, args: string[], signal: AbortSignal) {
  const child = spawn('python3', ['-I', '-c', script, ...args], { stdio: ['ignore', 'pipe', 'ignore'], signal });
  const done = new Promise<boolean>(resolve => {
    child.on('error', () => {});
    child.once('close', code => resolve(code === 0));
  });
  return { child, done };
}

export async function* readSnapshot(source: string, signal: AbortSignal): AsyncGenerator<Buffer> {
  // Resolve aliases above the selected root (macOS uses /var -> /private/var).
  // The helper still opens the selected directory and every entry below it with O_NOFOLLOW.
  const root = join(await realpath(dirname(source)), basename(source));
  const { child, done } = python(SOURCE, [root], signal);
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  let used = 0;
  try {
    for await (const data of child.stdout as AsyncIterable<Buffer>) {
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
    if (!await done) throw new Error('Cannot read a stable folder snapshot. Check source paths, file types and Python 3 availability.');
    if (used) yield chunk.subarray(0, used);
  } finally {
    child.kill();
    await done;
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

export async function installSnapshot(source: string, dest: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  // After launching the atomic commit, let it report its outcome even if cancellation arrives.
  const { done } = python(INSTALL, [source, dest], new AbortController().signal);
  if (!await done) throw new Error('Exclusive install failed');
}
