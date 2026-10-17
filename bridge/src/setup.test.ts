import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { performSetup, type SetupDependencies } from './setup.js';
import { readSetupState, REQUIRED_SETUP_ASSETS } from './setup-state.js';

async function fixture(run: (home: string, root: string) => Promise<void>): Promise<void> {
  const previous = process.env.HOME; const temporary = mkdtempSync(join(tmpdir(), 'ftown-setup-'));
  const home = join(temporary, 'home'); const root = join(temporary, 'package'); mkdirSync(home); mkdirSync(root);
  writeFileSync(join(root, 'package.json'), '{"version":"1.2.3"}'); process.env.HOME = home;
  try { await run(home, root); } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; rmSync(temporary, { recursive: true, force: true }); }
}

function dependencies(home: string, calls: string[], fail = false): SetupDependencies {
  return {
    migrate: (repair) => { calls.push(`migrate:${repair}`); return []; },
    installRuntime: () => { calls.push('runtime'); },
    integrations: async () => { calls.push('integrations'); if (fail) throw new Error('required hook failure'); return [{ name: 'missing native binary', status: 'skipped' }, { name: 'disabled plugin', status: 'skipped' }]; },
    skillAndPath: () => {
      calls.push('skill/path');
      for (const path of REQUIRED_SETUP_ASSETS) {
        const full = join(home, '.ftown', path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, path === 'cli/package.json' ? '{"version":"1.2.3"}' : 'asset');
      }
    },
  };
}

test('explicit setup installs once; repair rechecks optional integrations; upgrade refreshes readiness', async () => fixture(async (home, root) => {
  const calls: string[] = []; const deps = dependencies(home, calls);
  assert.equal((await performSetup({ root, dependencies: deps })).action, 'installed');
  assert.equal(readSetupState().packageVersion, '1.2.3');
  const count = calls.length;
  assert.equal((await performSetup({ root, dependencies: deps })).action, 'current'); assert.equal(calls.length, count);
  await performSetup({ root, repair: true, dependencies: deps }); assert.ok(calls.includes('migrate:true'));
  writeFileSync(join(root, 'package.json'), '{"version":"1.2.4"}');
  await performSetup({ root, dependencies: deps }); assert.equal(readSetupState().packageVersion, '1.2.4');
}));

test('required failure invalidates readiness and leaves setup retryable', async () => fixture(async (home, root) => {
  const calls: string[] = [];
  await assert.rejects(performSetup({ root, dependencies: dependencies(home, calls, true) }), /required hook failure/);
  assert.equal(readSetupState().packageVersion, undefined);
  assert.equal(calls.includes('skill/path'), false);
  await performSetup({ root, dependencies: dependencies(home, calls) });
  assert.equal(readSetupState().packageVersion, '1.2.3');
  await assert.rejects(performSetup({ root, repair: true, dependencies: dependencies(home, calls, true) }), /required hook failure/);
  assert.equal(readSetupState().packageVersion, undefined, 'a failed repair cannot leave stale ready state');
}));


test('a held setup serializes integration writes and stale versions fail before mutation', async () => fixture(async (home, root) => {
  const calls: string[] = [];
  let releaseIntegration: (() => void) | undefined;
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const deps = dependencies(home, calls);
  deps.integrations = async () => { started?.(); await new Promise<void>((resolve) => { releaseIntegration = resolve; }); return []; };
  const active = performSetup({ root, dependencies: deps });
  await ready;
  await assert.rejects(performSetup({ root, dependencies: dependencies(home, calls) }), /Another ftown setup/);
  releaseIntegration?.(); await active;
  writeFileSync(join(root, 'package.json'), '{"version":"1.2.2"}');
  const count = calls.length;
  await assert.rejects(performSetup({ root, repair: true, dependencies: dependencies(home, calls) }), /newer/);
  assert.equal(calls.length, count);
  assert.equal(readSetupState().packageVersion, '1.2.3');
}));
