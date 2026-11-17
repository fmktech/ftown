import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runStart, type StartDependencies } from './start-commands.js';

test('start checks readiness before loading native bridge code and forwards options unchanged', async () => {
  const calls: string[] = [];
  const argv = ['--solo', '--port', '8041', '--data-dir', '/tmp/bridge data'];
  const dependencies: StartDependencies = {
    assertReady: () => { calls.push('ready'); },
    loadBridge: async () => {
      calls.push('load');
      return { runBridge: async (actual, commandName) => {
        calls.push('run');
        assert.deepEqual(actual, argv);
        assert.equal(commandName, 'ftown start');
        return 3;
      } };
    },
  };
  assert.equal(await runStart(argv, dependencies), 3);
  assert.deepEqual(calls, ['ready', 'load', 'run']);
});

test('missing or outdated setup never loads native bridge dependencies', async () => {
  let loaded = false;
  await assert.rejects(runStart(['--solo'], {
    assertReady: () => { throw new Error('Run matching ftown setup'); },
    loadBridge: async () => { loaded = true; throw new Error('should not load'); },
  }), /Run matching ftown setup/);
  assert.equal(loaded, false);
});

test('default startup checks readiness before loading the bridge, preserving its return code', async () => {
  const order: string[] = [];
  assert.equal(await runStart([], {
    assertReady: () => { order.push('ready'); },
    loadBridge: async () => { order.push('load'); return { runBridge: async argv => {
      assert.deepEqual(argv, []); order.push('run'); return 4;
    } }; },
  }), 4);
  assert.deepEqual(order, ['ready', 'load', 'run']);
});

test('standalone help is discoverable without setup, while option values cannot bypass readiness', async () => {
  let checks = 0;
  const argvSeen: string[][] = [];
  const dependencies: StartDependencies = {
    assertReady: () => { checks++; },
    loadBridge: async () => ({ runBridge: async (argv) => { argvSeen.push(argv); return 0; } }),
  };
  for (const flag of ['--help', '-h']) assert.equal(await runStart([flag], dependencies), 0);
  assert.equal(checks, 0);
  assert.equal(await runStart(['--data-dir', '--help'], dependencies), 0);
  assert.equal(checks, 1);
  assert.equal(await runStart([], dependencies), 0);
  assert.equal(checks, 2);
  assert.deepEqual(argvSeen, [['--help'], ['-h'], ['--data-dir', '--help'], []]);
});

test('upgrade installs exact latest then starts installed copy with original arguments and loop guard', async () => {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const args = ['--solo', '--port', '8041'];
  const code = await runStart(args, {
    env: {}, version: () => '1.2.3', fetchLatest: async () => '1.3.0',
    beginUpgrade: () => ({ commit: () => {}, rollback: () => { throw new Error('unexpected rollback'); } }),
    spawn: async (command, argv, env) => { calls.push({ command, args: argv, env }); return calls.length === 1 ? 0 : 7; },
    assertReady: () => {}, loadBridge: async () => ({ runBridge: async () => { throw new Error('must re-exec'); } }),
  });
  assert.equal(code, 7);
  assert.deepEqual(calls[0].args, ['-y', 'ftown@1.3.0', 'setup']);
  assert.deepEqual(calls[1].args.slice(1), ['start', ...args]);
  assert.equal(calls[1].env.FTOWN_UPGRADE_DONE, '1');
});

test('update opt outs and help never query; no-update is removed before bridge parsing', async () => {
  const seen: string[][] = [];
  for (const [args, env] of [[['--no-update', '--solo'], {}], [['--help'], {}], [[], { CI: '1' }], [[], { FTOWN_VERSION: '1.0.0' }], [[], { FTOWN_UPGRADE_DONE: '1' }], [[], { FTOWN_NO_AUTO_UPDATE: '1' }], [[], { NODE_TEST_CONTEXT: 'child' }]] as Array<[string[], NodeJS.ProcessEnv]>) {
    await runStart(args, { env, fetchLatest: async () => { throw new Error('unexpected fetch'); }, assertReady: () => {}, loadBridge: async () => ({ runBridge: async argv => { seen.push(argv); return 0; } }) });
  }
  assert.deepEqual(seen[0], ['--solo']);
});

test('registry failure and failed setup fall back to current bridge', async () => {
  const debug: string[] = []; let runs = 0; let warnings = 0;
  const originalWarn = console.warn; console.warn = () => { warnings++; };
  const common: StartDependencies = { env: {}, version: () => '1.2.3', assertReady: () => {}, loadBridge: async () => ({ runBridge: async () => { runs++; return 4; } }), debug: message => debug.push(message), beginUpgrade: () => ({ commit: () => {}, rollback: () => 'current' as const }) };
  try {
    assert.equal(await runStart([], { ...common, fetchLatest: async () => { throw new Error('offline'); } }), 4);
    assert.equal(debug.length, 1);
    assert.equal(await runStart([], { ...common, fetchLatest: async () => '1.2.4', spawn: async () => 1 }), 4);
    assert.equal(warnings, 1); assert.equal(runs, 2);
  } finally { console.warn = originalWarn; }
});

test('failed setup uses the bridge loaded while the current installation was ready', async () => {
  let ready = true; let loaded = 0; let started = 0;
  const previousWarn = console.warn; console.warn = () => {};
  try {
    const result = await runStart(['--solo'], {
      env: {}, version: () => '1.0.0', fetchLatest: async () => '1.0.1',
      assertReady: () => { assert.equal(ready, true); },
      loadBridge: async () => { assert.equal(ready, true); loaded++; return { runBridge: async argv => { assert.equal(ready, true); assert.deepEqual(argv, ['--solo']); started++; return 6; } }; },
      beginUpgrade: () => ({ commit: () => { throw new Error('unexpected commit'); }, rollback: () => { ready = true; return 'current'; } }),
      spawn: async () => { ready = false; return 1; },
    });
    assert.equal(result, 6); assert.equal(loaded, 1); assert.equal(started, 1);
  } finally { console.warn = previousWarn; }
});

test('failed rollback prevents starting an unverified installation', async () => {
  let started = false;
  await assert.rejects(runStart([], {
    env: {}, version: () => '1.0.0', fetchLatest: async () => '1.0.1', assertReady: () => {},
    loadBridge: async () => ({ runBridge: async () => { started = true; return 0; } }),
    beginUpgrade: () => ({ commit: () => {}, rollback: () => { throw new Error('restore failed'); } }),
    spawn: async () => { throw new Error('spawn failed'); },
  }), /could not be restored: restore failed/);
  assert.equal(started, false);
});

test('help with no-update needs no configured installation', async () => {
  const seen: string[][] = [];
  assert.equal(await runStart(['--no-update', '--help'], {
    env: {}, assertReady: () => { throw new Error('not configured'); },
    loadBridge: async () => ({ runBridge: async args => { seen.push(args); return 0; } }),
    fetchLatest: async () => { throw new Error('unexpected fetch'); },
  }), 0);
  assert.deepEqual(seen, [['--help']]);
});

test('version ordering uses semantic version precedence', async () => {
  const { isNewerVersion } = await import('./start-commands.js');
  assert.equal(isNewerVersion('1.10.0', '1.9.9'), true);
  assert.equal(isNewerVersion('1.0.0', '1.0.0-rc.1'), true);
  assert.equal(isNewerVersion('1.0.0-rc.2', '1.0.0-rc.10'), false);
  assert.equal(isNewerVersion('1.0.0+build.2', '1.0.0+build.1'), false);
  assert.throws(() => isNewerVersion('1.0.0;bad', '1.0.0'));
});

test('filesystem rollback restores readiness and preserves a concurrent ready installation', async () => {
  const { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { dirname, join, relative } = await import('node:path');
  const { beginUpgrade } = await import('./start-commands.js');
  const { REQUIRED_SETUP_ASSETS, assertSetupReady, writeSetupState, acquireSetupLock } = await import('./setup-state.js');
  const { REQUIRED_RUNTIME_FILES } = await import('./installation-manifest.js');
  const home = mkdtempSync(join(tmpdir(), 'ftown-upgrade-'));
  const oldOpen = process.env.OPENCODE_CONFIG_DIR; const oldXdg = process.env.XDG_CONFIG_HOME;
  process.env.OPENCODE_CONFIG_DIR = join(home, 'opencode'); delete process.env.XDG_CONFIG_HOME;
  try {
    writeSetupState({ schema: 1, packageVersion: '1.2.3', completedMigrations: ['one'] }, home);
    for (const path of REQUIRED_SETUP_ASSETS) {
      const target = join(home, '.ftown', path); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, path === 'cli/installation.json' ? JSON.stringify({ schema: 1, packageVersion: '1.2.3', files: [...new Set([...REQUIRED_RUNTIME_FILES, ...REQUIRED_SETUP_ASSETS.filter(asset => asset.startsWith('cli/') && asset !== 'cli/installation.json').map(asset => asset.slice(4))])] }) : 'original');
    }
    const skills = join(home, 'opencode', 'skills'); mkdirSync(skills, { recursive: true });
    symlinkSync(relative(skills, join(home, '.ftown', 'skills', 'ftown')), join(skills, 'ftown'));
    const statePath = join(home, '.ftown', 'setup-state.json');
    const entryPath = join(home, '.ftown', 'cli', 'dist', 'ftown-cli.js');
    const originalState = readFileSync(statePath, 'utf8');
    let time = 0; let releaseHolder: (() => void) | undefined;
    const tx = beginUpgrade(home, '1.2.3', {
      now: () => time,
      wait: async ms => { time += ms; if (time >= 15_000 && releaseHolder) { releaseHolder(); releaseHolder = undefined; } },
    });
    assertSetupReady('1.2.3', home);
    writeSetupState({ schema: 1, completedMigrations: ['one', 'two'] }, home);
    writeFileSync(entryPath, 'partial');
    releaseHolder = acquireSetupLock(home);
    assert.equal(await tx.rollback(), 'current'); assertSetupReady('1.2.3', home);
    assert.equal(time, 15_000);
    assert.equal(readFileSync(entryPath, 'utf8'), 'original');
    assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')).completedMigrations, ['one', 'two']);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).packageVersion, JSON.parse(originalState).packageVersion);
    assert.equal(readdirSync(join(home, '.ftown')).filter(name => name.startsWith('.startup-upgrade-')).length, 0);
    const next = beginUpgrade(home, '1.2.3');
    writeFileSync(entryPath, 'concurrent');
    writeFileSync(join(home, '.ftown', 'cli', 'installation.json'), JSON.stringify({ schema: 1, packageVersion: '1.2.4', files: [...new Set([...REQUIRED_RUNTIME_FILES, ...REQUIRED_SETUP_ASSETS.filter(asset => asset.startsWith('cli/') && asset !== 'cli/installation.json').map(asset => asset.slice(4))])] }));
    writeSetupState({ schema: 1, packageVersion: '1.2.4', completedMigrations: [] }, home);
    assert.equal(await next.rollback(), 'installed'); assertSetupReady('1.2.4', home);
    assert.equal(readdirSync(join(home, '.ftown')).filter(name => name.startsWith('.startup-upgrade-')).length, 0);
    assert.equal(readFileSync(entryPath, 'utf8'), 'concurrent');
    let elapsed = 0;
    const timeout = beginUpgrade(home, '1.2.4', { now: () => elapsed, wait: async ms => { elapsed += ms; } });
    const release = acquireSetupLock(home);
    try { await assert.rejects(timeout.rollback(), /Another ftown setup/); }
    finally { release(); }
    assert.equal(elapsed, 60_000);
    assertSetupReady('1.2.4', home);
  } finally {
    if (oldOpen === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = oldOpen;
    if (oldXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldXdg;
    rmSync(home, { recursive: true, force: true });
  }
});
