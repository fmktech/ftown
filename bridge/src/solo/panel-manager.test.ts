import { execFile, spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ChecksumError,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  PanelBundleError,
  PanelStartError,
  ensurePanelBundle,
  findPanelServerDir,
  normalizePanelVersion,
  panelBundleUrl,
  startPanel,
  stopPanel,
} from './panel-manager.js';

import type { ChildProcess } from 'node:child_process';

const execFileP = promisify(execFile);

// ---------- tmp scaffolding ----------

let tmpRoot = '';

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ftown-panel-test-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

async function freshDataDir(label: string): Promise<string> {
  return path.join(tmpRoot, `data-${label}`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** A pid value that cannot exist (above every platform's pid_max). */
const IMPOSSIBLE_PID = 2_147_483_646;

// ---------- tar fixture builders ----------

/** Benign archive built with the SYSTEM tar (exercises real-world formats). */
async function buildArchiveWithSystemTar(srcDir: string): Promise<Buffer> {
  const out = path.join(tmpRoot, `fixture-${Math.random().toString(36).slice(2)}.tar.gz`);
  await execFileP('tar', ['-czf', out, '.'], { cwd: srcDir });
  return fs.readFile(out);
}

function writeOctal(buf: Buffer, pos: number, len: number, value: number): void {
  const text = value.toString(8).padStart(len - 1, '0');
  buf.write(`${text}\0`, pos, len, 'latin1');
}

interface CraftedEntry {
  name: string;
  type?: string;
  size?: number;
  linkname?: string;
  content?: Buffer;
}

/**
 * Hand-built ustar entry header (512 bytes). Needed because system tar
 * sanitizes hostile names ("../") at creation time — hostile fixtures must be
 * crafted directly in the exact on-disk format tar reads back.
 */
function tarHeaderBytes(entry: CraftedEntry): Buffer {
  const h = Buffer.alloc(512);
  h.write(entry.name.slice(0, 100), 0, 100, 'latin1');
  writeOctal(h, 100, 8, 0o644);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, entry.size ?? entry.content?.length ?? 0);
  writeOctal(h, 136, 12, 0);
  h.fill(' ', 148, 156); // checksum computed over spaces
  h.write(entry.type ?? '0', 156, 1, 'ascii');
  if (entry.linkname !== undefined) h.write(entry.linkname.slice(0, 100), 157, 100, 'latin1');
  h.write('ustar\0', 257, 6, 'latin1');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(sum.toString(8).padStart(6, '0'), 148, 6, 'latin1');
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

function paddedBody(content: Buffer): Buffer {
  const pad = (512 - (content.length % 512)) % 512;
  return pad === 0 ? content : Buffer.concat([content, Buffer.alloc(pad)]);
}

function craftTarGz(entries: CraftedEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(tarHeaderBytes(entry));
    if (entry.content && entry.content.length > 0) parts.push(paddedBody(entry.content));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

function sha256HexOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------- fetch stubs ----------

type ServingMap = Record<string, Buffer | string>;

function fetchServing(map: ServingMap, counter?: { calls: number }): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    if (counter) counter.calls += 1;
    const key = input instanceof URL ? input.href : String(input);
    const hit = map[key];
    if (hit === undefined) {
      return { ok: false, status: 404, statusText: 'Not Found' } as unknown as Response;
    }
    const buffer = typeof hit === 'string' ? Buffer.from(hit, 'utf8') : hit;
    return {
      ok: true,
      status: 200,
      text: async () => buffer.toString('utf8'),
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const healthyProbe = (async (): Promise<Response> =>
  ({ status: 200 }) as unknown as Response) as unknown as typeof fetch;

// ---------- fake child process ----------

interface SpawnRecord {
  args: readonly string[];
  opts: { cwd?: string; env?: NodeJS.ProcessEnv };
}

class FakeChild extends EventEmitter {
  pid = IMPOSSIBLE_PID;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stderr: PassThrough = new PassThrough();
  signals: string[] = [];

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.signals.push(String(signal));
    this.signalCode = String(signal);
    queueMicrotask(() => this.emit('exit', null, String(signal)));
    return true;
  }

  emitExit(code: number | null, signal: string | null): void {
    this.exitCode = code;
    queueMicrotask(() => this.emit('exit', code, signal));
  }
}

/**
 * Injectable spawnImpl capturing every call. `onSpawn` runs synchronously
 * after the fake is created (e.g. to stage an immediate crash).
 */
function fakeSpawn(
  records: SpawnRecord[],
  children: FakeChild[],
  onSpawn?: (child: FakeChild) => void,
): typeof nodeSpawn {
  return ((command: string, args: readonly string[], options: object): ChildProcess => {
    const child = new FakeChild();
    records.push({
      args: [command, ...args],
      opts: options as { cwd?: string; env?: NodeJS.ProcessEnv },
    });
    children.push(child);
    onSpawn?.(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof nodeSpawn;
}

// ---------- misc helpers ----------

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function pidDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

// =====================================================================
// panelBundleUrl
// =====================================================================

describe('panelBundleUrl', () => {
  it('substitutes every <version> placeholder in the frozen template', () => {
    assert.equal(
      panelBundleUrl('1.2.3'),
      'https://github.com/fmktech/ftown/releases/download/ui-v1.2.3/ftown-ui-standalone-1.2.3.tar.gz',
    );
  });

  it('is parameterized — different versions yield distinct URLs', () => {
    assert.notEqual(panelBundleUrl('0.0.1'), panelBundleUrl('9.9.9'));
    assert.match(panelBundleUrl('0.0.1'), /ui-v0\.0\.1\/ftown-ui-standalone-0\.0\.1\.tar\.gz$/);
  });

  it('resolves the exact release asset URL for a bare version (no double-v)', () => {
    assert.equal(
      panelBundleUrl('0.19.20'),
      'https://github.com/fmktech/ftown/releases/download/ui-v0.19.20/ftown-ui-standalone-0.19.20.tar.gz',
    );
  });
});

// =====================================================================
// normalizePanelVersion
// =====================================================================

describe('normalizePanelVersion', () => {
  it('strips a single leading lowercase v', () => {
    assert.equal(normalizePanelVersion('v0.19.20'), '0.19.20');
  });

  it('strips a single leading uppercase V', () => {
    assert.equal(normalizePanelVersion('V0.19.20'), '0.19.20');
  });

  it('leaves a bare version unchanged', () => {
    assert.equal(normalizePanelVersion('0.19.20'), '0.19.20');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(normalizePanelVersion('  0.19.20  '), '0.19.20');
    assert.equal(normalizePanelVersion('  v0.19.20  '), '0.19.20');
  });

  it('only strips one leading v, not v-prefixed content beyond that', () => {
    assert.equal(normalizePanelVersion('v1.0.0-v2'), '1.0.0-v2');
  });

  it('composes with panelBundleUrl to avoid the double-v bug', () => {
    assert.equal(
      panelBundleUrl(normalizePanelVersion('v0.19.20')),
      'https://github.com/fmktech/ftown/releases/download/ui-v0.19.20/ftown-ui-standalone-0.19.20.tar.gz',
    );
  });
});

// =====================================================================
// ensurePanelBundle — download, verify, extract, cache
// =====================================================================

describe('ensurePanelBundle', () => {
  it('downloads, verifies against the sidecar, extracts, writes a 0600 .ok marker', async () => {
    const dataDir = await freshDataDir('happy');
    const version = '1.4.2';
    const src = path.join(tmpRoot, 'src-happy');
    await fs.mkdir(path.join(src, 'nested'), { recursive: true });
    await fs.writeFile(path.join(src, 'server.js'), 'console.log("standalone")\n');
    await fs.writeFile(path.join(src, 'nested', 'chunk.js'), '// chunk\n');

    const archive = await buildArchiveWithSystemTar(src);
    const url = panelBundleUrl(version);
    const counter = { calls: 0 };

    const dir = await ensurePanelBundle({
      dataDir,
      version,
      fetchImpl: fetchServing({ [url]: archive, [`${url}.sha256`]: `${sha256HexOf(archive)}\n` }, counter),
    });

    assert.equal(dir, path.join(dataDir, 'solo', 'panel', version));
    assert.equal(await fs.readFile(path.join(dir, 'server.js'), 'utf8'), 'console.log("standalone")\n');
    assert.equal(await fs.readFile(path.join(dir, 'nested', 'chunk.js'), 'utf8'), '// chunk\n');

    const markerStat = await fs.stat(path.join(dir, '.ok'));
    assert.equal(markerStat.mode & 0o777, 0o600);
    assert.equal(await exists(path.join(dir, 'bundle.tar.gz')), false, 'archive removed after install');
    assert.equal(counter.calls, 2);
  });

  it('returns the cached dir with ZERO fetches once .ok exists', async () => {
    const dataDir = await freshDataDir('cache');
    const version = '2.0.0';
    const src = path.join(tmpRoot, 'src-cache');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'server.js'), 'x\n');

    const archive = await buildArchiveWithSystemTar(src);
    const url = panelBundleUrl(version);
    const counter = { calls: 0 };
    const serving = fetchServing({ [url]: archive, [`${url}.sha256`]: sha256HexOf(archive) }, counter);

    const first = await ensurePanelBundle({ dataDir, version, fetchImpl: serving });
    assert.ok(counter.calls > 0);

    const second = await ensurePanelBundle({ dataDir, version, fetchImpl: serving });
    assert.equal(second, first);
    assert.equal(counter.calls, 2, 'cached call must not touch the network');
  });

  it('aborts with ChecksumError and cleans up on sidecar mismatch', async () => {
    const dataDir = await freshDataDir('mismatch');
    const version = '3.1.4';
    const src = path.join(tmpRoot, 'src-mismatch');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'server.js'), 'payload\n');

    const archive = await buildArchiveWithSystemTar(src);
    const url = panelBundleUrl(version);
    const wrongDigest = sha256HexOf(Buffer.from('not-the-archive'));

    await assert.rejects(
      ensurePanelBundle({
        dataDir,
        version,
        fetchImpl: fetchServing({ [url]: archive, [`${url}.sha256`]: wrongDigest }),
      }),
      (err: Error) => err instanceof ChecksumError && /mismatch/.test(err.message),
    );

    assert.equal(await exists(path.join(dataDir, 'solo', 'panel', version)), false);
    const leftovers = await fs.readdir(path.join(dataDir, 'solo', 'panel'));
    assert.deepEqual(leftovers, []);
  });

  it('rejects malformed sidecars with ChecksumError', async () => {
    const dataDir = await freshDataDir('badsidecar');
    const url = panelBundleUrl('4.0.0');
    await assert.rejects(
      ensurePanelBundle({
        dataDir,
        version: '4.0.0',
        fetchImpl: fetchServing({ [url]: Buffer.from('anything'), [`${url}.sha256`]: 'definitely-not-hex' }),
      }),
      (err: Error) => err instanceof ChecksumError && /malformed/.test(err.message),
    );
  });

  it('surfaces HTTP failures as PanelBundleError', async () => {
    const dataDir = await freshDataDir('httpfail');
    await assert.rejects(
      ensurePanelBundle({
        dataDir,
        version: '5.0.0',
        fetchImpl: (async (): Promise<Response> =>
          ({ ok: false, status: 503 }) as unknown as Response) as unknown as typeof fetch,
      }),
      (err: Error) => err instanceof PanelBundleError && err.message.includes('503'),
    );
  });
});

// =====================================================================
// ensurePanelBundle — S4/S17 extraction hardening (offline crafted tars)
// =====================================================================

describe('ensurePanelBundle extraction hardening (S4/S17)', () => {
  interface HostileCase {
    label: string;
    version: string;
    archive: Buffer;
  }

  const MB = 1024 * 1024;

  function hostileCases(): HostileCase[] {
    return [
      {
        label: "traversal entry '../evil.txt'",
        version: 't1',
        archive: craftTarGz([
          { name: 'server.js', content: Buffer.from('ok\n') },
          { name: '../evil.txt', content: Buffer.from('pwned\n') },
        ]),
      },
      {
        label: "absolute entry '/abs/evil.txt'",
        version: 't2',
        archive: craftTarGz([{ name: '/abs/evil.txt', content: Buffer.from('pwned\n') }]),
      },
      {
        label: "symlink entry 'link -> /etc/hosts'",
        version: 't3',
        archive: craftTarGz([
          { name: 'server.js', content: Buffer.from('ok\n') },
          { name: 'link', type: '2', linkname: '/etc/hosts' },
        ]),
      },
      {
        label: "hardlink entry",
        version: 't4',
        archive: craftTarGz([
          { name: 'server.js', content: Buffer.from('ok\n') },
          { name: 'hard', type: '1', linkname: 'server.js' },
        ]),
      },
      {
        label: 'per-entry cap breach (declares MAX_ENTRY_BYTES+1)',
        version: 't5',
        archive: craftTarGz([{ name: 'bomb.bin', size: MAX_ENTRY_BYTES + 1, content: Buffer.alloc(512) }]),
      },
      {
        label: 'total cap breach (three ~180MB declarations)',
        version: 't6',
        archive: craftTarGz([
          { name: 'a.bin', size: 180 * MB, content: Buffer.alloc(16) },
          { name: 'b.bin', size: 180 * MB, content: Buffer.alloc(16) },
          { name: 'c.bin', size: 180 * MB, content: Buffer.alloc(16) },
        ]),
      },
      {
        label: `entry-count cap breach (${MAX_ENTRIES + 1} entries)`,
        version: 't7',
        archive: craftTarGz(
          Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({
            name: `f/${i}.txt`,
            content: Buffer.alloc(0),
          })),
        ),
      },
    ];
  }

  for (const testCase of hostileCases()) {
    it(`aborts pre-extract and cleans up: ${testCase.label}`, async () => {
      const dataDir = await freshDataDir(testCase.version);
      const url = panelBundleUrl(testCase.version);
      await assert.rejects(
        ensurePanelBundle({
          dataDir,
          version: testCase.version,
          fetchImpl: fetchServing({
            [url]: testCase.archive,
            [`${url}.sha256`]: sha256HexOf(testCase.archive),
          }),
        }),
        (err: Error) => err instanceof PanelBundleError,
      );
      // Nothing extracted anywhere — version dir wiped, nothing escaped.
      assert.equal(await exists(path.join(dataDir, 'solo', 'panel', testCase.version)), false);
      assert.equal(await exists(path.join(dataDir, 'solo', 'panel', 'evil.txt')), false);
      assert.equal(await exists('/abs'), false);
    });
  }

  it('rejects symlink fixtures produced by the SYSTEM tar too', async () => {
    const dataDir = await freshDataDir('sys-link');
    const version = 'sys-link';
    const src = path.join(tmpRoot, 'src-symlink');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'server.js'), 'ok\n');
    const outsideTarget = path.join(tmpRoot, 'outside-secret.txt');
    await fs.writeFile(outsideTarget, 'secret\n');
    await fs.symlink(outsideTarget, path.join(src, 'escape'));

    const archive = await buildArchiveWithSystemTar(src);
    const url = panelBundleUrl(version);
    await assert.rejects(
      ensurePanelBundle({
        dataDir,
        version,
        fetchImpl: fetchServing({ [url]: archive, [`${url}.sha256`]: sha256HexOf(archive) }),
      }),
      (err: Error) => err instanceof PanelBundleError,
    );
    assert.equal(await exists(path.join(dataDir, 'solo', 'panel', version)), false);
  });
});

// =====================================================================
// findPanelServerDir
// =====================================================================

describe('findPanelServerDir', () => {
  it('finds server.js at the extract root (shallow)', async () => {
    const root = path.join(tmpRoot, 'flat');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'server.js'), '');
    assert.equal(await findPanelServerDir(root), root);
  });

  it('finds server.js one level deep', async () => {
    const root = path.join(tmpRoot, 'deep');
    const pkg = path.join(root, 'ftown-ui-standalone');
    await fs.mkdir(pkg, { recursive: true });
    await fs.writeFile(path.join(pkg, 'server.js'), '');
    assert.equal(await findPanelServerDir(root), pkg);
  });

  it('prefers the shallow root when both levels have one', async () => {
    const root = path.join(tmpRoot, 'both');
    const nested = path.join(root, 'pkg');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(root, 'server.js'), '');
    await fs.writeFile(path.join(nested, 'server.js'), '');
    assert.equal(await findPanelServerDir(root), root);
  });

  it('throws PanelBundleError when no standalone root exists', async () => {
    const root = path.join(tmpRoot, 'empty');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'README'), '');
    await assert.rejects(findPanelServerDir(root), (err: Error) => err instanceof PanelBundleError);
  });
});

// =====================================================================
// startPanel — argv/env security contract (mocked spawn, S15)
// =====================================================================

describe('startPanel spawn contract (S15)', () => {
  it('argv is exactly [execPath, server.js]; HOSTNAME pinned to loopback; no secrets anywhere', async () => {
    const dataDir = await freshDataDir('contract');
    const bundleDir = path.join(tmpRoot, 'bundle-flat');
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, 'server.js'), '');

    const records: SpawnRecord[] = [];
    const children: FakeChild[] = [];
    const running = await startPanel({
      bundleDir,
      port: 54321,
      dataDir,
      env: { EXTRA_FLAG: 'yes' },
      spawnImpl: fakeSpawn(records, children),
      healthFetchImpl: healthyProbe,
    });

    assert.equal(records.length, 1);
    assert.deepEqual(records[0].args, [process.execPath, path.join(bundleDir, 'server.js')]);
    assert.equal(records[0].opts.cwd, bundleDir);
    assert.equal(running.pid, children[0].pid);
    assert.equal(running.serverDir, bundleDir);

    const env = records[0].opts.env ?? {};
    assert.equal(env.HOSTNAME, '127.0.0.1', 'HOSTNAME pins the standalone server to loopback');
    assert.equal(env.PORT, '54321');
    assert.equal(env.EXTRA_FLAG, 'yes');

    // S15: secret-shaped values must appear NOWHERE in argv/env.
    const SECRETS = ['AKIA-top-secret-value', 'deadbeefcafe0123456789abcdef42424242'];
    const serialized = JSON.stringify({ args: records[0].args, env });
    for (const secret of SECRETS) assert.ok(!serialized.includes(secret));

    // Pidfile written immediately (orphan detectability during boot).
    const raw = await fs.readFile(path.join(dataDir, 'solo', 'panel.pid'), 'utf8');
    assert.equal((JSON.parse(raw) as { pid: number }).pid, children[0].pid);
    await stopPanel(dataDir);
  });

  it('reports premature exit with sanitized stderr and removes the pidfile', async () => {
    const dataDir = await freshDataDir('crash');
    const bundleDir = path.join(tmpRoot, 'bundle-crash');
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, 'server.js'), '');

    const longHex = 'f00dfeedcafef00dfeedcafef00dfeed'; // secret-shaped
    const records: SpawnRecord[] = [];
    const children: FakeChild[] = [];
    const spawnImpl = fakeSpawn(records, children, (child) => {
      queueMicrotask(() => {
        child.stderr.write(`FATAL: listen failed ${longHex} boom\n`);
        child.emitExit(1, null);
      });
    });

    const startedAt = Date.now();
    await assert.rejects(
      startPanel({
        bundleDir,
        port: 54322,
        dataDir,
        probeIntervalMs: 10,
        spawnImpl,
        healthFetchImpl: healthyProbe,
      }),
      (err: Error) =>
        err instanceof PanelStartError &&
        /prematurely/.test(err.message) &&
        err.message.includes('boom') &&
        !err.message.includes(longHex), // secret-shaped stderr is redacted
    );
    assert.ok(Date.now() - startedAt < 5_000);

    assert.ok(!children[0].signals.includes('SIGTERM'), 'already-dead child is not signalled again');
    assert.equal(await exists(path.join(dataDir, 'solo', 'panel.pid')), false);
  });

  it('gives up after the health budget, SIGTERMs the child, removes the pidfile', async () => {
    const dataDir = await freshDataDir('unhealthy');
    const bundleDir = path.join(tmpRoot, 'bundle-unhealthy');
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, 'server.js'), '');

    const children: FakeChild[] = [];
    const refused = (async (): Promise<Response> => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const startedAt = Date.now();
    await assert.rejects(
      startPanel({
        bundleDir,
        port: 54323,
        dataDir,
        probeTimeoutMs: 20,
        probeIntervalMs: 10,
        probeMaxWaitMs: 150,
        spawnImpl: fakeSpawn([], children),
        healthFetchImpl: refused,
      }),
      (err: Error) => err instanceof PanelStartError && /healthy/.test(err.message),
    );
    assert.ok(Date.now() - startedAt < 10_000, 'give-up respects its budget');
    assert.ok(children[0].signals.includes('SIGTERM'));
    assert.equal(await exists(path.join(dataDir, 'solo', 'panel.pid')), false);
  });
});

// =====================================================================
// Lifecycle L2 — pidfile semantics, stale reap, real spawn/stop
// =====================================================================

describe('lifecycle (L2)', () => {
  const STUB_SERVER_JS = `
const http = require('node:http');
const server = http.createServer((req, res) => {
  const head = req.method === 'HEAD';
  res.writeHead(head ? 204 : 200, { 'content-type': 'text/plain' });
  res.end(head ? undefined : 'ok');
});
server.listen(Number(process.env.PORT), process.env.HOSTNAME || '127.0.0.1');
`;

  async function makeRealBundle(label: string): Promise<{ bundleDir: string; dataDir: string }> {
    const dataDir = await freshDataDir(label);
    const bundleDir = path.join(tmpRoot, `bundle-${label}`);
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, 'server.js'), STUB_SERVER_JS);
    return { bundleDir, dataDir };
  }

  it('end-to-end: real spawn answers HEAD / (<500), stopPanel kills it and cleans up', async () => {
    const { bundleDir, dataDir } = await makeRealBundle('e2e');
    const port = await freePort();

    const running = await startPanel({ bundleDir, port, dataDir });
    try {
      assert.ok(running.pid > 0);
      const probe = await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' });
      assert.ok(probe.status < 500, 'stub standalone answers HEAD /');

      const raw = await fs.readFile(path.join(dataDir, 'solo', 'panel.pid'), 'utf8');
      assert.equal((JSON.parse(raw) as { pid: number }).pid, running.pid);
    } finally {
      await stopPanel(dataDir);
    }

    assert.ok(pidDead(running.pid), 'stopPanel terminates the panel child');
    assert.equal(await exists(path.join(dataDir, 'solo', 'panel.pid')), false);
  });

  it('reaps a LIVE orphan recorded in a stale pidfile before spawning (L2)', async () => {
    const { bundleDir, dataDir } = await makeRealBundle('orphan');
    const orphan = nodeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)']);
    await new Promise<void>((resolve, reject) => {
      orphan.once('spawn', () => resolve());
      orphan.once('error', reject);
    });
    const orphanPid = orphan.pid;
    assert.ok(orphanPid);

    await fs.mkdir(path.join(dataDir, 'solo'), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'solo', 'panel.pid'),
      `${JSON.stringify({ pid: orphanPid, port: 1, startedAt: 'previous-run' })}\n`,
    );

    const records: SpawnRecord[] = [];
    const children: FakeChild[] = [];
    try {
      await startPanel({
        bundleDir,
        port: 54324,
        dataDir,
        spawnImpl: fakeSpawn(records, children),
        healthFetchImpl: healthyProbe,
      });
      assert.ok(pidDead(orphanPid), 'live orphan reaped via SIGTERM');
    } finally {
      try {
        orphan.kill('SIGKILL');
      } catch {
        // Already reaped.
      }
    }

    const raw = await fs.readFile(path.join(dataDir, 'solo', 'panel.pid'), 'utf8');
    assert.equal((JSON.parse(raw) as { pid: number }).pid, children[0].pid, 'pidfile replaced by new child');
    await stopPanel(dataDir);
  });

  it('tolerates a stale pidfile naming a DEAD pid', async () => {
    const { bundleDir, dataDir } = await makeRealBundle('deadpid');
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(exited.status, 0);
    const deadPid = exited.pid;
    assert.ok(deadPid);
    assert.ok(pidDead(deadPid));

    await fs.mkdir(path.join(dataDir, 'solo'), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'solo', 'panel.pid'),
      `${JSON.stringify({ pid: deadPid, port: 1 })}\n`,
    );

    const records: SpawnRecord[] = [];
    const children: FakeChild[] = [];
    await startPanel({
      bundleDir,
      port: 54325,
      dataDir,
      spawnImpl: fakeSpawn(records, children),
      healthFetchImpl: healthyProbe,
    });
    const raw = await fs.readFile(path.join(dataDir, 'solo', 'panel.pid'), 'utf8');
    assert.equal((JSON.parse(raw) as { pid: number }).pid, children[0].pid);
    await stopPanel(dataDir);
  });

  it('stopPanel is a safe no-op without a pidfile, and idempotent', async () => {
    const { dataDir } = await makeRealBundle('noop');
    await assert.doesNotReject(stopPanel(dataDir));
    await assert.doesNotReject(stopPanel(dataDir));
  });
});
