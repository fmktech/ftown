import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function runFixture(t, scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'ftown-version-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of ['scripts/ci', 'scripts/release', 'bridge', 'bin']) mkdirSync(join(dir, path), { recursive: true });
  for (const path of ['scripts/ci/run-job.sh', 'scripts/release/package-changes.mjs', 'scripts/release/publish-packages.mjs']) copyFileSync(join(root, path), join(dir, path));
  writeFileSync(join(dir, 'scripts/ci/setup-runtime.sh'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'bridge/package.json'), JSON.stringify({ name: 'ftown-bridge', version: '1.2.3' }));
  writeFileSync(join(dir, 'bridge/package-lock.json'), JSON.stringify({ packages: { '': { version: '1.2.3' } } }));
  const git = `#!/bin/sh\nprintf 'git %s\\n' "$*" >> "$FIXTURE_LOG"\ncase "$1" in\n  diff) if [ "$FIXTURE_CASE" != skip ]; then printf 'bridge/src/runtime.ts\\0'; fi;;\n  show) printf '{"version":"1.2.2"}\\n';;\n  *) echo unexpected-git >&2; exit 9;;\nesac\n`;
  const npm = `#!/bin/sh\nprintf 'npm %s\\n' "$*" >> "$FIXTURE_LOG"\ncase "$FIXTURE_CASE:$2" in\n  collision-ftown:ftown@1.2.3|collision-bridge:ftown-bridge@1.2.3) name="\${2%@*}"; printf '{"name":"%s","version":"1.2.3","gitHead":"same"}\\n' "$name";;\n  network:*) printf '{"error":{"code":"ENETUNREACH"}}\\n'; exit 1;;\n  *) printf '{"error":{"code":"E404"}}\\n'; exit 1;;\nesac\n`;
  for (const [name, body] of [['git', git], ['npm', npm]]) { const path = join(dir, 'bin', name); writeFileSync(path, body); chmodSync(path, 0o755); }
  const log = join(dir, 'calls');
  const env = { PATH: `${join(dir, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`, BASE: 'a'.repeat(40), HEAD: 'b'.repeat(40), FIXTURE_CASE: scenario, FIXTURE_LOG: log };
  const result = spawnSync('bash', ['scripts/ci/run-job.sh', 'bridge-version'], { cwd: dir, env, encoding: 'utf8', timeout: 10_000 });
  return { ...result, calls: readFileSync(log, 'utf8') };
}

test('bridge-version checks both unpublished package names only for package changes', t => {
  const accepted = runFixture(t, 'absent');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.calls, /npm view ftown@1\.2\.3 --json/);
  assert.match(accepted.calls, /npm view ftown-bridge@1\.2\.3 --json/);
  assert.doesNotMatch(accepted.calls, /git rev-parse/);
  const skipped = runFixture(t, 'skip');
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.doesNotMatch(skipped.calls, /npm /);
});

test('bridge-version rejects either collision and registry failures', t => {
  for (const scenario of ['collision-ftown', 'collision-bridge', 'network']) {
    const result = runFixture(t, scenario);
    assert.notEqual(result.status, 0, scenario);
    assert.match(result.stderr, /already published|Cannot inspect/);
  }
});
