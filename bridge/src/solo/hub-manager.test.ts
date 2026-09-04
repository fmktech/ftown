import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn as realSpawn, spawnSync } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { HUB_CHANNEL_DEFAULTS, HUB_JWT_AUDIENCE, HUB_NAMESPACES } from './contract.js';
import {
  ArchiveSafetyError,
  assetUrl,
  ChecksumError,
  ensureHubBinary,
  assertSafeTarEntries,
  HubStartError,
  resolvePlatformTriple,
  startHub,
  stopHub,
  UnsupportedPlatformError,
  writeHubConfig,
} from './hub-manager.js';
import type { HubChildProcess, SpawnLike, StartHubOptions } from './hub-manager.js';

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'hub-manager-test-'));
after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const TRIPLE = resolvePlatformTriple();

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(TMP_ROOT, `${prefix}-`));
}

interface StubServer {
  port: number;
  close(): Promise<void>;
}

function startHttpServer(status: number): Promise<StubServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.statusCode = status;
      res.end(req.url === '/health' && status === 200 ? 'ok' : 'nope');
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

class StubHubChild extends EventEmitter {
  pid: number | undefined = 424242;
  stdout: NodeJS.ReadableStream | null = null;
  stderr: NodeJS.ReadableStream | null = null;
  killSignals: (NodeJS.Signals | number | undefined)[] = [];

  constructor(stderr?: PassThrough) {
    super();
    if (stderr) this.stderr = stderr;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    queueMicrotask(() => this.emit('exit', null, signal ?? 'SIGTERM'));
    return true;
  }
}

const asChild = (stub: StubHubChild): HubChildProcess => stub as unknown as HubChildProcess;

interface SpawnCapture {
  command: string;
  args: string[];
  options: SpawnOptions;
}

interface StubRun {
  server: StubServer;
  running: Awaited<ReturnType<typeof startHub>>;
  captures: SpawnCapture[];
  children: StubHubChild[];
  configPath: string;
  pidFile: string;
}

async function startStubHub(
  dataDir: string,
  opts: { status?: number; binPath?: string; childrenWithStderr?: PassThrough[] } = {},
): Promise<StubRun> {
  const server = await startHttpServer(opts.status ?? 200);
  const configPath = path.join(dataDir, 'solo', 'hub.json');
  await writeHubConfig(configPath, { port: 59999, secret: 'test-hub-secret-0123456789' });
  const captures: SpawnCapture[] = [];
  const children: StubHubChild[] = [];
  let childIndex = 0;
  const spawnImpl: SpawnLike = (command, args, options) => {
    captures.push({ command, args: [...args], options });
    const child = new StubHubChild(opts.childrenWithStderr?.[childIndex]);
    childIndex += 1;
    children.push(child);
    return asChild(child);
  };
  const binPath = opts.binPath ?? '/opt/ftown/bin/centrifugo-v5.4.9';
  try {
    const running = await startHub({
      configPath,
      binPath,
      dataDir,
      spawnImpl,
      healthBaseUrl: `http://127.0.0.1:${server.port}`,
      healthIntervalMs: 10,
      healthTryTimeoutMs: 250,
      healthDeadlineMs: 5000,
    });
    return { server, running, captures, children, configPath, pidFile: path.join(dataDir, 'solo', 'hub.pid') };
  } catch (err) {
    await server.close();
    throw err;
  }
}

async function untilDead(pid: number, label: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${label} (pid ${pid}) still alive after stop`);
}

describe('resolvePlatformTriple', () => {
  it('maps the four supported platform/arch pairs', () => {
    assert.equal(resolvePlatformTriple('darwin', 'arm64'), 'darwin-arm64');
    assert.equal(resolvePlatformTriple('darwin', 'x64'), 'darwin-amd64');
    assert.equal(resolvePlatformTriple('linux', 'x64'), 'linux-amd64');
    assert.equal(resolvePlatformTriple('linux', 'arm64'), 'linux-arm64');
  });

  it('throws UnsupportedPlatformError naming the unsupported pair', () => {
    assert.throws(() => resolvePlatformTriple('win32', 'x64'), (err: unknown) => {
      assert.ok(err instanceof UnsupportedPlatformError);
      assert.match(err.message, /win32\/x64/);
      return true;
    });
    assert.throws(
      () => resolvePlatformTriple('freebsd', 'arm64'),
      (err: unknown) => err instanceof UnsupportedPlatformError && /freebsd\/arm64/.test(err.message),
    );
  });
});

describe('assetUrl', () => {
  it('builds the pinned GitHub release asset URL shape', () => {
    assert.equal(
      assetUrl('v5.4.9', 'linux-amd64'),
      'https://github.com/centrifugal/centrifugo/releases/download/v5.4.9/centrifugo_5.4.9_linux_amd64.tar.gz',
    );
  });

  it('uses underscores in the filename triple (verified against v5.4.9 checksums.txt)', () => {
    assert.equal(
      assetUrl('v5.4.9', 'darwin-arm64'),
      'https://github.com/centrifugal/centrifugo/releases/download/v5.4.9/centrifugo_5.4.9_darwin_arm64.tar.gz',
    );
  });
});

describe('writeHubConfig', () => {
  it('writes EXACTLY the frozen keys with mode 0600', async () => {
    const dir = tmpDir('cfg');
    const configPath = path.join(dir, 'hub.json');
    await writeHubConfig(configPath, { port: 8041, secret: 'super-secret-value' });

    assert.equal(statSync(configPath).mode & 0o777, 0o600);

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(parsed, {
      address: '127.0.0.1',
      port: 8041,
      token_hmac_secret_key: 'super-secret-value',
      token_audience: HUB_JWT_AUDIENCE,
      allowed_origins: [],
      websocket_compression: false,
      allow_anonymous_connect_without_token: false,
      admin: false,
      api_disable: true,
      health: true,
      ...HUB_CHANNEL_DEFAULTS,
      namespaces: HUB_NAMESPACES,
      allow_user_limited_channels: true,
      client_channel_limit: 256,
      client_queue_max_size: 67108864,
      client_stale_close_delay: '30s',
      websocket_message_size_limit: 33554432,
      ping_interval: '10s',
      pong_timeout: '5s',
    });
    assert.deepEqual(Object.keys(parsed).sort(), [
      'address',
      'admin',
      'allow_anonymous_connect_without_token',
      'allow_history_for_subscriber',
      'allow_presence_for_subscriber',
      'allow_user_limited_channels',
      'allowed_origins',
      'api_disable',
      'client_channel_limit',
      'client_queue_max_size',
      'client_stale_close_delay',
      'force_push_join_leave',
      'force_recovery',
      'health',
      'history_size',
      'history_ttl',
      'join_leave',
      'namespaces',
      'ping_interval',
      'pong_timeout',
      'port',
      'presence',
      'token_audience',
      'token_hmac_secret_key',
      'websocket_compression',
      'websocket_message_size_limit',
    ]);
  });

  it('never enables admin/api or opens bind address/origins (S7 boundary)', async () => {
    const dir = tmpDir('cfg-boundary');
    const configPath = path.join(dir, 'hub.json');
    await writeHubConfig(configPath, { port: 8042, secret: 'another-secret-value' });
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    assert.equal(parsed.address, '127.0.0.1');
    assert.equal(parsed.api_disable, true);
    assert.equal(parsed.admin, false);
    assert.deepEqual(parsed.allowed_origins, []);
  });

  it('drift guard: namespaces + channel defaults match production centrifugo/config.json exactly (fixes code 102 unknown channel)', async () => {
    const prodConfigPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      '..',
      '..',
      '..',
      'centrifugo',
      'config.json',
    );
    const prodConfig = JSON.parse(readFileSync(prodConfigPath, 'utf8')) as Record<string, unknown>;
    assert.ok(Array.isArray(prodConfig.namespaces), 'production config must define namespaces');
    assert.deepEqual(
      HUB_NAMESPACES,
      prodConfig.namespaces,
      'solo hub namespaces have drifted from production centrifugo/config.json — ' +
        'every namespaced channel (bridges:presence#solo, commands:rpc#solo, ' +
        'loops:updates#solo, sessions:*, terminal:*, terminal-input:*, events:*) ' +
        'will 102 "unknown channel" if these are not identical',
    );

    for (const key of Object.keys(HUB_CHANNEL_DEFAULTS)) {
      assert.deepEqual(
        HUB_CHANNEL_DEFAULTS[key],
        prodConfig[key],
        `HUB_CHANNEL_DEFAULTS.${key} has drifted from production centrifugo/config.json ` +
          `top-level "${key}" — namespaces without their own override inherit this default`,
      );
    }

    const dir = tmpDir('cfg-drift');
    const configPath = path.join(dir, 'hub.json');
    await writeHubConfig(configPath, { port: 8043, secret: 'drift-guard-secret-value' });
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(parsed.namespaces, prodConfig.namespaces);
    for (const key of Object.keys(HUB_CHANNEL_DEFAULTS)) {
      assert.deepEqual(parsed[key], prodConfig[key]);
    }
    assert.equal(parsed.address, '127.0.0.1');
    assert.equal(parsed.api_disable, true);
    assert.equal(parsed.admin, false);
    assert.deepEqual(parsed.allowed_origins, []);
  });

  it('keeps 0600 when overwriting an existing file (S7)', async () => {
    const dir = tmpDir('cfg-overwrite');
    const configPath = path.join(dir, 'hub.json');
    writeFileSync(configPath, '{}\n', { mode: 0o644 });
    await writeHubConfig(configPath, { port: 1, secret: 'x'.repeat(16) });
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
  });
});

describe('ensureHubBinary', () => {
  function buildFixtureArchive(dir: string): Buffer {
    const srcDir = path.join(dir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(path.join(srcDir, 'centrifugo'), '#!/bin/sh\necho hub-stub\n', { mode: 0o755 });
    const archivePath = path.join(dir, 'fixture.tar.gz');
    const result = spawnSync('tar', ['-czf', archivePath, 'centrifugo'], { cwd: srcDir });
    assert.equal(result.status, 0, `tar fixture failed: ${result.stderr?.toString()}`);
    return readFileSync(archivePath);
  }

  it('downloads against the digest map, extracts, installs 0700, then serves from cache', async () => {
    const dir = tmpDir('ensure-happy');
    const bytes = buildFixtureArchive(dir);
    let fetches = 0;
    const fetchImpl = async (): Promise<Response> => {
      fetches += 1;
      return new Response(bytes);
    };
    const digests = { [TRIPLE]: sha256(bytes) };

    const target = await ensureHubBinary({ dataDir: dir, version: 'v9.9.9', fetchImpl, digests });

    assert.equal(target, path.join(dir, 'solo', 'bin', 'centrifugo-v9.9.9'));
    assert.equal(readFileSync(target, 'utf8'), '#!/bin/sh\necho hub-stub\n');
    assert.equal(statSync(target).mode & 0o777, 0o700);

    await ensureHubBinary({ dataDir: dir, version: 'v9.9.9', fetchImpl, digests });
    assert.equal(fetches, 1, 'second call must be served from the verified cache');

    assert.deepEqual(readdirSync(path.join(dir, 'solo')), ['bin'], 'no temp leftovers');
    assert.deepEqual(readdirSync(path.join(dir, 'solo', 'bin')).sort(), [
      'centrifugo-v9.9.9',
      'centrifugo-v9.9.9.sha256',
    ]);
  });

  it('aborts on checksum mismatch: ChecksumError, nothing extracted, no temp leftovers (S6)', async () => {
    const dir = tmpDir('ensure-badsha');
    const badBytes = Buffer.from('#!/bin/sh\nnot-the-real-binary\n');
    const fetchImpl = async (): Promise<Response> => new Response(badBytes);

    await assert.rejects(
      ensureHubBinary({ dataDir: dir, fetchImpl }),
      (err: unknown): boolean => {
        assert.ok(err instanceof ChecksumError, `expected ChecksumError, got ${String(err)}`);
        assert.match(err.message, /checksum mismatch/i);
        assert.match(err.message, /nothing was extracted/i);
        return true;
      },
    );

    const soloDir = path.join(dir, 'solo');
    assert.ok(!existsSync(path.join(soloDir, 'bin', 'centrifugo-v5.4.9')));
    assert.deepEqual(
      readdirSync(soloDir).filter((name) => name.startsWith('.')),
      [],
      'download/extract temp files must be cleaned up',
    );
  });

  it('rejects non-200 downloads', async () => {
    const dir = tmpDir('ensure-httpfail');
    const fetchImpl = async (): Promise<Response> => new Response(null, { status: 404 });
    await assert.rejects(ensureHubBinary({ dataDir: dir, fetchImpl }), ChecksumError);
  });
});

describe('assertSafeTarEntries (S4/S17 extraction hardening)', () => {
  it('accepts regular files and directories with safe relative names', () => {
    assertSafeTarEntries(['centrifugo', 'sub', 'sub/readme.txt'], [
      '-rw-r--r--  0 user group 21 Aug 23 12:00 centrifugo',
      'drwxr-xr-x  0 user group  0 Aug 23 12:00 sub',
      '-rw-r--r--  0 user group  5 Aug 23 12:00 sub/readme.txt',
    ]);
  });

  it('rejects symlink entries', () => {
    assert.throws(
      () =>
        assertSafeTarEntries(['centrifugo', 'evil'], [
          '-rw-r--r-- 0 u g 21 x centrifugo',
          'lrwxr-xr-x 0 u g 21 x evil -> /etc/passwd',
        ]),
      ArchiveSafetyError,
    );
  });

  it('rejects hardlink entries', () => {
    assert.throws(() => assertSafeTarEntries(['evil'], ['hrw-r--r-- 0 u g 21 x evil']), ArchiveSafetyError);
  });

  it('rejects absolute entry paths', () => {
    assert.throws(
      () => assertSafeTarEntries(['/etc/passwd'], ['-rw-r--r-- 0 u g 21 x /etc/passwd']),
      ArchiveSafetyError,
    );
  });

  it('rejects ".." traversal segments', () => {
    assert.throws(
      () => assertSafeTarEntries(['../evil'], ['-rw-r--r-- 0 u g 21 x ../evil']),
      ArchiveSafetyError,
    );
  });

  it('rejects name/verbose listing mismatches', () => {
    assert.throws(() => assertSafeTarEntries(['a'], []), ArchiveSafetyError);
  });
});

describe('startHub', () => {
  it('spawns argv exactly [binPath, "-c", cfg] with piped stdio and no custom env (S15)', async () => {
    const dir = tmpDir('start-argv');
    const started = await startStubHub(dir);
    try {
      assert.equal(started.captures.length, 1);
      const cap = started.captures[0];
      assert.equal(cap.command, '/opt/ftown/bin/centrifugo-v5.4.9');
      assert.deepEqual([...cap.args], ['-c', started.configPath]);
      assert.deepEqual([cap.command, ...cap.args], [
        '/opt/ftown/bin/centrifugo-v5.4.9',
        '-c',
        started.configPath,
      ]);
      assert.deepEqual(cap.options.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(cap.options.env, undefined, 'no env overrides may reach the child');

      assert.equal(started.running.pid, 424242);
      assert.equal(started.running.port, 59999);

      assert.ok(existsSync(started.pidFile));
      assert.equal(statSync(started.pidFile).mode & 0o777, 0o600);
      assert.equal(readFileSync(started.pidFile, 'utf8'), '424242\n');
      assert.equal(started.children[0].killSignals.length, 0, 'healthy hub must not be killed');
    } finally {
      await started.server.close();
    }
  });

  it('probes health via the injected base-url override, not the config port', async () => {
    const dir = tmpDir('start-healthurl');
    // Config says port 59999 but only the injected stub server answers on its own
    // ephemeral port — success proves the override was used.
    const started = await startStubHub(dir);
    try {
      assert.equal(started.running.port, 59999);
      assert.ok(existsSync(started.pidFile));
    } finally {
      await started.server.close();
    }
  });

  it('fails with HubStartError on persistent unhealthy responses; kills child and removes pidfile', async () => {
    const dir = tmpDir('start-unhealthy');
    const server = await startHttpServer(503);
    const configPath = path.join(dir, 'solo', 'hub.json');
    await writeHubConfig(configPath, { port: 58888, secret: 'test-hub-secret-0123456789' });
    const child = new StubHubChild();
    const spawnImpl: SpawnLike = () => asChild(child);
    try {
      await assert.rejects(
        startHub({
          configPath,
          binPath: '/bin/hub',
          dataDir: dir,
          spawnImpl,
          healthBaseUrl: `http://127.0.0.1:${server.port}`,
          healthIntervalMs: 10,
          healthTryTimeoutMs: 200,
          healthDeadlineMs: 300,
        }),
        (err: unknown): boolean => {
          assert.ok(err instanceof HubStartError, String(err));
          assert.match(err.message, /did not become healthy within 300ms/i);
          return true;
        },
      );
      assert.deepEqual(child.killSignals, ['SIGKILL']);
      assert.ok(!existsSync(path.join(dir, 'solo', 'hub.pid')));
    } finally {
      await server.close();
    }
  });

  it('sanitizes stderr tails: secret redacted, never echoed (S16)', async () => {
    const dir = tmpDir('start-redact');
    const server = await startHttpServer(500);
    const configPath = path.join(dir, 'solo', 'hub.json');
    const secret = 'test-hub-secret-0123456789';
    await writeHubConfig(configPath, { port: 57777, secret });
    const stderrPipe = new PassThrough();
    const child = new StubHubChild(stderrPipe);
    const spawnImpl: SpawnLike = () => asChild(child);
    try {
      const pending = assert.rejects(
        startHub({
          configPath,
          binPath: '/bin/hub',
          dataDir: dir,
          spawnImpl,
          healthBaseUrl: `http://127.0.0.1:${server.port}`,
          healthIntervalMs: 10,
          healthTryTimeoutMs: 200,
          healthDeadlineMs: 400,
        }),
        (err: unknown): boolean => {
          assert.ok(err instanceof HubStartError, String(err));
          assert.match(err.message, /boom from hub/);
          assert.ok(!err.message.includes(secret), 'secret must never appear in the error tail');
          assert.match(err.message, /\[redacted\]/);
          return true;
        },
      );
      stderrPipe.write(`boom from hub token_hmac_secret_key=${secret}\n`);
      await pending;
    } finally {
      await server.close();
    }
  });

  it('reaps a stale pidfile pointing at a dead process before spawning (L2)', async () => {
    const dir = tmpDir('start-reap-dead');
    const victim = realSpawn(process.execPath, ['-e', 'process.exit(0)']);
    await once(victim, 'exit');
    assert.ok(typeof victim.pid === 'number');
    mkdirSync(path.join(dir, 'solo'), { recursive: true });
    writeFileSync(path.join(dir, 'solo', 'hub.pid'), `${victim.pid}\n`);

    const started = await startStubHub(dir);
    try {
      assert.equal(started.running.pid, 424242);
      assert.equal(readFileSync(started.pidFile, 'utf8'), '424242\n', 'stale pidfile replaced');
    } finally {
      await started.server.close();
    }
  });

  it('reaps a garbage pidfile without crashing (L2)', async () => {
    const dir = tmpDir('start-reap-garbage');
    mkdirSync(path.join(dir, 'solo'), { recursive: true });
    writeFileSync(path.join(dir, 'solo', 'hub.pid'), 'not-a-pid\n');

    const started = await startStubHub(dir);
    try {
      assert.equal(started.running.pid, 424242);
    } finally {
      await started.server.close();
    }
  });
});

describe('stopHub', () => {
  it('returns false when no pidfile exists', async () => {
    const dir = tmpDir('stop-none');
    assert.equal(await stopHub(dir), false);
  });

  it('kills the spawned stub process (SIGTERM path) and unlinks the pidfile', async () => {
    const dir = tmpDir('stop-real');
    const server = await startHttpServer(200);
    try {
      const soloDir = path.join(dir, 'solo');
      mkdirSync(soloDir, { recursive: true });
      const configPath = path.join(soloDir, 'hub.json');
      await writeHubConfig(configPath, { port: server.port, secret: 'irrelevant-secret-000' });
      const binPath = path.join(dir, 'stub-hub');
      writeFileSync(binPath, '#!/usr/bin/env node\nsetInterval(() => {}, 10000);\n', { mode: 0o755 });

      const running = await startHub({
        configPath,
        binPath,
        dataDir: dir,
        healthBaseUrl: `http://127.0.0.1:${server.port}`,
        healthIntervalMs: 10,
        healthTryTimeoutMs: 500,
        healthDeadlineMs: 5000,
      });
      const pid = running.pid;
      assert.ok(typeof pid === 'number');
      process.kill(pid, 0); // alive

      assert.equal(await stopHub(dir), true);
      await untilDead(pid, 'stub hub');
      assert.ok(!existsSync(path.join(dir, 'solo', 'hub.pid')));
    } finally {
      await server.close();
    }
  });

  it('reports false for a pidfile naming a dead process and cleans it up', async () => {
    const dir = tmpDir('stop-deadpid');
    const victim = realSpawn(process.execPath, ['-e', 'process.exit(0)']);
    await once(victim, 'exit');
    mkdirSync(path.join(dir, 'solo'), { recursive: true });
    writeFileSync(path.join(dir, 'solo', 'hub.pid'), `${victim.pid}\n`);
    assert.equal(await stopHub(dir), false);
    assert.ok(!existsSync(path.join(dir, 'solo', 'hub.pid')));
  });
});
