// Pure fixture-boundary checks: no server, database, browser or child process.
// (The old registration-fixture tests are gone: there is no registerUser/register route any more.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as nodeCrypto from 'node:crypto';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(repo, 'ui/package.json'));
const e2eRequire = createRequire(path.join(repo, 'e2e/package.json'));
const ts = require('typescript');
function helper(relative, imports, globals = {}) {
  const file = path.join(repo, relative);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  const isolatedRequire = name => {
    assert.ok(Object.hasOwn(imports, name), `Unexpected dependency: ${name}`);
    return imports[name];
  };
  new Script(code, { filename: relative }).runInNewContext({
    module, exports: module.exports, require: isolatedRequire, URL, Request, Response, ...globals,
  });
  return module.exports;
}

const root = '/isolated task/ftown';
const e2e = path.join(root, 'e2e');

function playwrightConfig(browserHome, platform = 'linux') {
  return helper('e2e/playwright.config.ts', {
    '@playwright/test': e2eRequire('@playwright/test'),
    'node:crypto': nodeCrypto,
    'node:fs': { existsSync: () => false, readFileSync: () => { throw new Error('unexpected read'); } },
    'node:path': path,
    './helpers/config': { E2E_DIR: e2e, UI_BASE_URL: 'http://localhost:3001' },
  }, { process: { platform, env: { CI: 'true', ...(browserHome === undefined ? {} : { E2E_BROWSER_HOME: browserHome }) } } }).default;
}

test('setup and chromium projects share browser security settings; chromium depends on setup', () => {
  const config = playwrightConfig();
  assert.equal(config.workers, 1);
  assert.equal(config.fullyParallel, false);
  assert.equal(config.retries, 0);
  assert.equal(config.forbidOnly, true);
  assert.equal(config.timeout, 90_000);
  assert.equal(config.expect.timeout, 15_000);
  assert.equal(config.use.actionTimeout, 15_000);
  assert.deepEqual(Array.from(config.projects, project => project.name), ['setup', 'chromium', 'second-passkey']);
  const [setup, chromium, secondPasskey] = config.projects;
  // The permanent second authority runs last, as the setup project's teardown (after chromium, pass or fail).
  assert.equal(setup.teardown, 'second-passkey');
  assert.equal(secondPasskey.dependencies, undefined);
  assert.equal(secondPasskey.use, chromium.use);
  assert.ok(secondPasskey.testMatch.test(path.join(e2e, 'tests', 'second-passkey.spec.ts')));
  assert.ok(chromium.testIgnore.test(path.join(e2e, 'tests', 'second-passkey.spec.ts')));
  assert.ok(setup.testMatch.test(path.join(e2e, 'tests', 'account.setup.ts')));
  assert.equal(setup.testMatch.test(path.join(e2e, 'tests', 'account.setup.ts.extra')), false);
  assert.equal(setup.dependencies, undefined);
  assert.deepEqual(Array.from(chromium.dependencies), ['setup']);
  assert.equal(setup.use, chromium.use);
  assert.equal(chromium.use.channel, 'chromium');
  const home = path.join(e2e, '.browser-home');
  const env = chromium.use.launchOptions.env;
  assert.equal(env.HOME, home);
  assert.equal(env.XDG_DATA_HOME, path.join(home, '.local/share'));
  assert.equal(env.XDG_CONFIG_HOME, path.join(home, '.config'));
  assert.equal(env.XDG_CACHE_HOME, path.join(home, '.cache'));
  assert.deepEqual(Array.from(chromium.use.launchOptions.args), [
    '--disable-features=WebRtcHideLocalIpsWithMdns', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  ]);
  assert.equal(config.use.trace, 'retain-on-failure');
  assert.equal(config.use.video, 'retain-on-failure');
  assert.equal(config.use.screenshot, 'only-on-failure');
  assert.deepEqual(Array.from(config.reporter, reporter => reporter[0]), ['list', 'html', 'json']);
  assert.equal(config.reporter[2][1].outputFile, 'test-results/results.json');
});

test('browser HOME/XDG override applies only on Linux', () => {
  const env = playwrightConfig(undefined, 'darwin').projects[1].use.launchOptions.env;
  assert.equal(env.HOME, undefined);
  assert.equal(env.XDG_DATA_HOME, undefined);
  assert.equal(env.CI, 'true');
});

test('an unowned E2E_BROWSER_HOME is rejected', () => {
  const home = path.join(e2e, '.browser-home');
  assert.doesNotThrow(() => playwrightConfig(home));
  for (const invalid of ['.browser-home', '/unowned/.browser-home', `${home}/../.browser-home`, '']) {
    assert.throws(() => playwrightConfig(invalid), /E2E_BROWSER_HOME must be the canonical/, JSON.stringify(invalid));
  }
});

function ledgerBridge(env = {}, uid = 501) {
  return helper('e2e/helpers/ledger-bridge.ts', {
    'node:child_process': {}, 'node:fs': {}, 'node:fs/promises': {}, 'node:path': path,
    'node:util': { promisify: fn => fn },
    './config': { E2E_DIR: e2e, UI_BASE_URL: 'http://localhost:3001' },
  }, { process: { env, getuid: () => uid } });
}

test('isolatedBridgeEnv drops inherited FTOWN_* and tmux variables', () => {
  const { isolatedBridgeEnv } = ledgerBridge({
    HOME: '/unowned', USERPROFILE: '/unowned', FTOWN_DATA_DIR: '/unowned/data', FTOWN_PUBLIC_URL: 'x', FTOWN_ANYTHING: '1',
    TMUX: '/tmp/tmux-1/default,1,0', TMUX_PANE: '%3', TMUX_TMPDIR: '/unowned/tmux', KEEP: 'preserved', PATH: '/bin',
  });
  const env = isolatedBridgeEnv('/h', '/tmp/ftpk-abc123');
  assert.equal(env.TMUX, undefined);
  assert.equal(env.TMUX_PANE, undefined);
  assert.equal(env.FTOWN_PUBLIC_URL, undefined);
  assert.equal(env.FTOWN_ANYTHING, undefined);
  assert.equal(env.KEEP, 'preserved');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/h');
  assert.equal(env.USERPROFILE, '/h');
  assert.equal(env.FTOWN_DATA_DIR, path.join('/h', '.ftown', 'data'));
  assert.equal(env.TMUX_TMPDIR, '/tmp/ftpk-abc123');
  assert.deepEqual(Object.keys(env).filter(k => k.startsWith('FTOWN_')), ['FTOWN_DATA_DIR']);
});

test('tmuxSocket accepts only /tmp/ftpk-XXXXXX directories', () => {
  const { tmuxSocket } = ledgerBridge({}, 501);
  assert.equal(tmuxSocket('/tmp/ftpk-aB3dE9'), '/tmp/ftpk-aB3dE9/tmux-501/ftown');
  assert.equal(tmuxSocket('/private/tmp/ftpk-aB3dE9'), '/private/tmp/ftpk-aB3dE9/tmux-501/ftown');
  for (const bad of ['', 'ftpk-aB3dE9', './ftpk-aB3dE9', 'tmp/ftpk-aB3dE9', '/tmp/tmux-501', '/tmp', '/tmp/', '/tmp/ftpk-',
    '/tmp/ftpk-aB3dE', '/tmp/ftpk-aB3dE98', '/tmp/ftpk-aB3d-9', '/tmp/ftpk-aB3dE9/', '/tmp/ftpk-aB3dE9/x',
    '/tmp/x/ftpk-aB3dE9', '/var/tmp/ftpk-aB3dE9', '/tmp/ftpk-aB3dE9/../tmux-501', '/other/tmp/ftpk-aB3dE9']) {
    assert.throws(() => tmuxSocket(bad), /unexpected test tmux dir/, JSON.stringify(bad));
  }
});

test('parsePairingOutput returns the last link+code pair, else null', () => {
  const { parsePairingOutput } = ledgerBridge();
  const link = n => `Open https://localhost:3001/pair#req=${n}abc`;
  const code = n => `Type this code on the page to confirm it is this computer: ${n}`;
  assert.deepEqual(JSON.parse(JSON.stringify(parsePairingOutput(`${link(1)}\n${code('111111')}\n`))),
    { link: 'https://localhost:3001/pair#req=1abc', code: '111111' });
  assert.deepEqual(JSON.parse(JSON.stringify(parsePairingOutput(`${link(1)}\n${code('111111')}\nrevoked\n${link(2)}\n${code('222222')}\n`))),
    { link: 'https://localhost:3001/pair#req=2abc', code: '222222' });
  assert.equal(parsePairingOutput(''), null);
  assert.equal(parsePairingOutput(`${link(1)}\n`), null);
  assert.equal(parsePairingOutput(`${code('111111')}\n`), null);
  // code printed before its link, or a newer link without its code yet
  assert.equal(parsePairingOutput(`${code('111111')}\n${link(1)}\n`), null);
  assert.equal(parsePairingOutput(`${link(1)}\n${code('111111')}\n${link(2)}\n`), null);
  assert.equal(parsePairingOutput(`${link(1)}\nType this code on the page to confirm it is this computer: 12345\n`), null);
});

test('replacement bridge keeps the exact entrypoint, no removed flags, isolated env and waits for the NEW pid', async () => {
  const home = path.join(e2e, '.bridge-home');
  const tmuxDir = '/tmp/ftpk-Zz9Yy8';
  const spawned = []; const writes = []; const readiness = []; let unreferenced = false;
  const proc = {
    env: { HOME: '/unowned', USERPROFILE: '/unowned', FTOWN_DATA_DIR: '/unowned/data', FTOWN_PUBLIC_URL: 'leak', TMUX: 'leak',
      TMUX_PANE: '%1', TMUX_TMPDIR: '/unowned/tmux', KEEP: 'preserved' },
    getuid: () => 501,
    kill: () => { throw new Error('old fixture process is absent'); },
  };
  const { isolatedBridgeEnv } = helper('e2e/helpers/ledger-bridge.ts', {
    'node:child_process': {}, 'node:fs': {}, 'node:fs/promises': {}, 'node:path': path, 'node:util': { promisify: fn => fn },
    './config': { E2E_DIR: e2e, UI_BASE_URL: 'http://localhost:3001' },
  }, { process: proc });
  const { restartBridge } = helper('e2e/helpers/bridge-process.ts', {
    'node:child_process': { spawn: (...args) => { spawned.push(args); return { pid: 901, unref() { unreferenced = true; } }; } },
    'node:fs': {
      openSync: () => 33,
      readFileSync: file => {
        if (file === path.join(e2e, '.bridge.tmux')) return `${tmuxDir}\n`;
        assert.equal(file, path.join(e2e, '.bridge.pid')); return '73\n';
      },
      writeFileSync: (...args) => writes.push(args),
    },
    'node:path': path,
    './config': { E2E_DIR: e2e, BRIDGE_HOME: home, UI_BASE_URL: 'http://localhost:3001' },
    './passkey': { sharedAccountId: () => 'acct-43-chars' },
    './centrifugo': { waitForBridgePresence: async (account, opts) => { readiness.push(['presence', account, opts.min]); } },
    './bridge-api': { readBridgePointer: candidate => { assert.equal(candidate, home); readiness.push(['pointer', 901]); return { pid: 901 }; } },
    './ledger-bridge': { isolatedBridgeEnv },
  }, { process: proc, setTimeout: () => { throw new Error('unexpected readiness wait'); } });
  assert.equal(await restartBridge(), 901);
  assert.equal(spawned.length, 1);
  const [executable, args, options] = spawned[0];
  assert.equal(executable, 'node');
  assert.deepEqual(Array.from(args), [path.join(root, 'bridge/dist/index.js'), '--api-url', 'http://localhost:3001']);
  for (const removed of ['--token', '--account', '--bootstrap']) assert.equal(args.includes(removed), false, removed);
  assert.equal(options.cwd, home);
  assert.equal(options.env.HOME, home);
  assert.equal(options.env.USERPROFILE, home);
  assert.equal(options.env.FTOWN_DATA_DIR, path.join(home, '.ftown', 'data'));
  assert.equal(options.env.TMUX_TMPDIR, tmuxDir);
  assert.equal(options.env.KEEP, 'preserved');
  for (const key of ['TMUX', 'TMUX_PANE', 'FTOWN_PUBLIC_URL']) assert.equal(options.env[key], undefined, key);
  assert.deepEqual(Object.keys(options.env).filter(k => k.startsWith('FTOWN_')), ['FTOWN_DATA_DIR']);
  assert.equal(options.detached, true); assert.equal(unreferenced, true);
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [[path.join(e2e, '.bridge.pid'), '901\n']]);
  assert.deepEqual(readiness, [['pointer', 901], ['presence', 'acct-43-chars', 1]]);
});
