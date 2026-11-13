import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetchOpencodeQuota } from './opencode.js';
import type { ProviderQuota } from './types.js';

const OBSERVED = '2026-11-13T10:00:00.000Z';
const NOW = new Date(OBSERVED);
const NO_USAGE = 'opencode has no usage command for its subscription plans';

const savedPath = process.env.PATH;
const opened: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-quota-test-'));
  opened.push(dir);
  return dir;
}

afterEach(async () => {
  while (opened.length > 0) {
    const dir = opened.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
});

function expected(status: ProviderQuota['status'], message: string): ProviderQuota {
  return {
    provider: 'opencode',
    status,
    plan: null,
    windows: [],
    source: 'live',
    observedAt: OBSERVED,
    message,
  };
}

describe('fetchOpencodeQuota', () => {
  it('reports the CLI as not found when neither the bundled binary nor PATH has it', async () => {
    const homeDir = await tempDir();
    const emptyPath = await tempDir();
    process.env.PATH = emptyPath;
    const quota = await fetchOpencodeQuota({ timeoutMs: 5000, now: () => NOW, homeDir });
    assert.deepEqual(quota, expected('unavailable', 'opencode CLI not found'));
  });

  it('reports no usage command when the bundled binary exists', async () => {
    const homeDir = await tempDir();
    const binDir = join(homeDir, '.opencode', 'bin');
    await mkdir(binDir, { recursive: true });
    const binary = join(binDir, 'opencode');
    await writeFile(binary, '');
    await chmod(binary, 0o755);
    process.env.PATH = await tempDir();
    const quota = await fetchOpencodeQuota({ timeoutMs: 5000, now: () => NOW, homeDir });
    assert.deepEqual(quota, expected('unavailable', NO_USAGE));
  });

  it('reports no usage command when opencode is on PATH', async () => {
    const homeDir = await tempDir();
    const pathDir = await tempDir();
    const binary = join(pathDir, 'opencode');
    await writeFile(binary, '');
    await chmod(binary, 0o755);
    process.env.PATH = pathDir;
    const quota = await fetchOpencodeQuota({ timeoutMs: 5000, now: () => NOW, homeDir });
    assert.deepEqual(quota, expected('unavailable', NO_USAGE));
  });
});
