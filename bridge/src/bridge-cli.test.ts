import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bridgeRoot = fileURLToPath(new URL('..', import.meta.url));

test('ftown-bridge uses the hosted API when --api-url is omitted', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/index.ts', '--help'],
    { cwd: bridgeRoot, encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--api-url <url>/);
  assert.match(result.stdout, /default: "https:\/\/ftown\.ia\.br"/);
});
