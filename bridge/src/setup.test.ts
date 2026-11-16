import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { opencodeSkillsDir } from './install-ftown-skill.js';
import { performSetup, type SetupDependencies } from './setup.js';
import { setupAccountTargets } from './setup.js';
import { saveAccounts } from './accounts.js';
import { readSetupState, REQUIRED_SETUP_ASSETS } from './setup-state.js';
import { REQUIRED_RUNTIME_FILES } from './installation-manifest.js';

async function fixture(run: (home: string, root: string) => Promise<void>): Promise<void> {
  const previous = process.env.HOME;
  const savedOpen = process.env.OPENCODE_CONFIG_DIR;
  const savedXdg = process.env.XDG_CONFIG_HOME;
  const temporary = mkdtempSync(join(tmpdir(), 'ftown-setup-'));
  const home = join(temporary, 'home'); const root = join(temporary, 'package'); mkdirSync(home); mkdirSync(root);
  writeFileSync(join(root, 'package.json'), '{"version":"1.2.3"}');
  process.env.HOME = home;
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.XDG_CONFIG_HOME;
  try { await run(home, root); } finally {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    if (savedOpen === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = savedOpen;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** The stubbed skill install still has to leave the link readiness checks. */
function linkOpencodeFtownSkill(home: string): void {
  const dir = opencodeSkillsDir(home, process.env);
  mkdirSync(dir, { recursive: true });
  const link = join(dir, 'ftown');
  try { unlinkSync(link); } catch { /* absent on the first install */ }
  symlinkSync(relative(dir, join(home, '.ftown', 'skills', 'ftown')), link);
}

function dependencies(home: string, calls: string[], fail = false): SetupDependencies {
  return {
    migrate: (repair) => { calls.push(`migrate:${repair}`); return []; },
    installRuntime: () => { calls.push('runtime'); },
    integrations: async () => { calls.push('integrations'); if (fail) throw new Error('required hook failure'); return [{ name: 'missing native binary', status: 'skipped' }, { name: 'disabled plugin', status: 'skipped' }]; },
    skillAndPath: () => {
      calls.push('skill/path');
      for (const path of REQUIRED_SETUP_ASSETS) {
        const full = join(home, '.ftown', path); mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, path === 'cli/installation.json' ? JSON.stringify({ schema: 1, packageVersion: '1.2.3', files: REQUIRED_RUNTIME_FILES }) : path === 'cli/package.json' ? '{"version":"1.2.3"}' : 'asset');
      }
      linkOpencodeFtownSkill(home);
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

test('setup targets the default and every distinct registered account config under a temporary HOME', async () => fixture(async (home) => {
  saveAccounts({ version: 1, accounts: [
    { id: 'personal', harness: 'claude', configDir: join(home, 'claude-personal') },
    { id: 'codex-lab', harness: 'codex', configDir: join(home, 'codex-lab') },
    { id: 'default-copy', harness: 'claude', configDir: join(home, '.claude') },
  ] });
  assert.deepEqual(setupAccountTargets().map(account => account?.configDir ?? 'default'), [
    'default', join(home, 'claude-personal'), join(home, 'codex-lab'),
  ]);
}));
