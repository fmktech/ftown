// Pure fixture-boundary checks: no server, database, browser or child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
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

function playwrightConfig(browserHome) {
  const e2e = path.join('/isolated task', 'ftown', 'e2e');
  return helper('e2e/playwright.config.ts', {
    '@playwright/test': e2eRequire('@playwright/test'),
    'node:path': path,
    './helpers/config': { E2E_DIR: e2e, UI_BASE_URL: 'http://localhost:3000' },
  }, { process: { env: { CI: 'true', ...(browserHome === undefined ? {} : { E2E_BROWSER_HOME: browserHome }) } } }).default;
}

test('Playwright assigns only explicitly isolated files to the concurrent lane', () => {
  const config = playwrightConfig();
  assert.equal(config.workers, 2);
  assert.equal(config.fullyParallel, false);
  assert.equal(config.retries, 0);
  assert.equal(config.forbidOnly, true);
  assert.equal(config.timeout, 90_000);
  assert.equal(config.expect.timeout, 15_000);
  assert.deepEqual(Array.from(config.projects, project => project.name), ['chromium', 'chromium-isolated']);
  const [shared, isolated] = config.projects;
  assert.equal(shared.workers, 1);
  assert.equal(shared.fullyParallel, false);
  assert.equal(isolated.fullyParallel, true);
  assert.equal(shared.dependencies, undefined);
  assert.equal(isolated.dependencies, undefined);
  assert.equal(shared.testIgnore, isolated.testMatch);
  assert.equal(isolated.testMatch.length, 2);
  const matches = file => isolated.testMatch.some(pattern => pattern.test(file));
  const testDir = path.join('/isolated task', 'ftown', 'e2e', 'tests');
  const names = ['account-trust.spec.ts', 'pending-approvals.spec.ts'];
  for (const [index, name] of names.entries()) {
    const canonical = path.join(testDir, name);
    assert.equal(matches(canonical), true, name);
    assert.equal(isolated.testMatch[index].test(canonical), true);
    assert.equal(isolated.testMatch[1 - index].test(canonical), false);
    for (const file of [path.join(testDir, 'nested', 'tests', name), path.join(testDir, 'nested', name),
      path.join('/unowned/e2e/tests', name), path.join('/isolated task/ftown/e2e-adjacent/tests', name),
      path.join(testDir, `${name}.extra`), path.join(testDir, `prefix-${name}`)]) {
      assert.equal(matches(file), false, file);
    }
  }
  assert.equal(matches(path.join(testDir, 'new.spec.ts')), false);
});

test('Playwright lanes share browser security settings and reject an unowned browser home', () => {
  const config = playwrightConfig();
  const [shared, isolated] = config.projects;
  assert.equal(shared.use, isolated.use);
  assert.equal(shared.use.channel, 'chromium');
  const home = path.join('/isolated task', 'ftown', 'e2e', '.browser-home');
  assert.equal(shared.use.launchOptions.env.HOME, home);
  assert.equal(shared.use.launchOptions.env.XDG_DATA_HOME, path.join(home, '.local/share'));
  assert.equal(shared.use.launchOptions.env.XDG_CONFIG_HOME, path.join(home, '.config'));
  assert.equal(shared.use.launchOptions.env.XDG_CACHE_HOME, path.join(home, '.cache'));
  assert.deepEqual(Array.from(shared.use.launchOptions.args), [
    '--disable-features=WebRtcHideLocalIpsWithMdns', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  ]);
  assert.equal(config.use.trace, 'retain-on-failure');
  assert.equal(config.use.video, 'retain-on-failure');
  assert.equal(config.use.screenshot, 'only-on-failure');
  assert.deepEqual(Array.from(config.reporter, reporter => reporter[0]), ['list', 'html', 'json']);
  assert.equal(config.reporter[2][1].outputFile, 'test-results/results.json');
  assert.doesNotThrow(() => playwrightConfig(home));
  for (const invalid of ['.browser-home', '/unowned/.browser-home', `${home}/../.browser-home`]) {
    assert.throws(() => playwrightConfig(invalid), /E2E_BROWSER_HOME must be the canonical/);
  }
});
const { clientIp } = helper('ui/src/lib/client-ip.ts', {});
function registrar(origin = 'http://localhost:3000') {
  const attempts = new Map(); const requests = [];
  const { registerUser } = helper('e2e/helpers/app.ts', {
    '@playwright/test': {}, './config': { UI_BASE_URL: origin },
    './secure-browser': {}, './bridge-api': {}, 'node:crypto': { createHash },
  }, {
    fetch: async (url, options) => {
      requests.push({ url, options });
      const ip = clientIp(new Request(url, options));
      const count = (attempts.get(ip) ?? 0) + 1; attempts.set(ip, count);
      // Deliberately modeled quota, not a test of the production SQL limiter.
      return new Response('{}', { status: count > 10 ? 429 : 200 });
    },
  });
  return { registerUser, attempts, requests };
}
test('eleven logical fixture users have separate proxied source keys and real registration bodies', async () => {
  const fixture = registrar();
  for (let i = 0; i < 11; i++) await fixture.registerUser(`e2e-fixture-${i}@ftown.test`, 'unit-password-123');
  assert.equal(fixture.attempts.size, 11);
  for (const [ip, count] of fixture.attempts) {
    assert.equal(isIP(ip), 6); assert.ok(ip.startsWith('2001:db8:')); assert.equal(count, 1);
  }
  assert.equal(fixture.requests.length, 11);
  assert.equal(fixture.requests[0].url, 'http://localhost:3000/api/auth/register');
  assert.equal(fixture.requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(fixture.requests[0].options.body), { email: 'e2e-fixture-0@ftown.test', password: 'unit-password-123' });
});
test('same normalized fixture identity keeps one quota and its eleventh request is still rejected', async () => {
  const fixture = registrar();
  for (let i = 0; i < 10; i++) await fixture.registerUser(i % 2 ? 'E2E-REPEAT@FTOWN.TEST' : 'e2e-repeat@ftown.test');
  await assert.rejects(fixture.registerUser('e2e-repeat@ftown.test'), /register failed: 429/);
  assert.equal(fixture.attempts.size, 1);
  assert.equal([...fixture.attempts.values()][0], 11);
});
test('registration source is stable across helper instances and cannot target a remote or noncanonical origin', async () => {
  const first = registrar(); const second = registrar();
  await first.registerUser('e2e-stable@ftown.test'); await second.registerUser('e2e-stable@ftown.test');
  assert.deepEqual([...first.attempts.keys()], [...second.attempts.keys()]);
  for (const origin of ['https://example.test', 'http://localhost:3000/', 'http://127.0.0.1:3000',
    'http://localhost:3000/path', 'http://localhost:3000?query=1', 'http://localhost:3000#fragment',
    'http://user:password@localhost:3000', ' http://localhost:3000', 'http:localhost:3000']) {
    const fixture = registrar(origin);
    await assert.rejects(fixture.registerUser('e2e-local@ftown.test'));
    assert.equal(fixture.requests.length, 0);
  }
  const fixture = registrar();
  await assert.rejects(fixture.registerUser('fixture@example.test'));
  assert.equal(fixture.requests.length, 0);
});
test('replacement bridge retains the exact cleanup entrypoint, owned environment and new PID readiness', async () => {
  const root = '/isolated task/ftown'; const e2e = path.join(root, 'e2e'); const home = path.join(e2e, '.bridge-home');
  const spawned = []; const writes = []; const readiness = []; let unreferenced = false;
  const { restartBridge } = helper('e2e/helpers/bridge-process.ts', {
    'node:child_process': { spawn: (...args) => { spawned.push(args); return { pid: 901, unref() { unreferenced = true; } }; } },
    'node:fs': {
      openSync: () => 33,
      readFileSync: file => { assert.equal(file, path.join(e2e, '.bridge.pid')); return '73\n'; },
      writeFileSync: (...args) => writes.push(args),
    },
    'node:path': path,
    './config': { E2E_DIR: e2e, BRIDGE_HOME: home, UI_BASE_URL: 'http://localhost:3000' },
    './jwt': { mintBridgeBootstrapToken: () => 'unit-bootstrap-placeholder' },
    './app': { sharedEmail: () => 'e2e-restart@ftown.test' },
    './centrifugo': { waitForBridgePresence: async email => { readiness.push(['presence', email]); } },
    './bridge-api': { readBridgePointer: candidate => { assert.equal(candidate, home); readiness.push(['pointer', 901]); return { pid: 901 }; } },
  }, {
    process: { env: { HOME: '/unowned', USERPROFILE: '/unowned', FTOWN_DATA_DIR: '/unowned/data', KEEP: 'preserved' },
      kill: () => { throw new Error('old fixture process is absent'); } },
    setTimeout: () => { throw new Error('unexpected readiness wait'); },
  });
  assert.equal(await restartBridge(), 901);
  assert.equal(spawned.length, 1);
  const [executable, args, options] = spawned[0];
  assert.equal(executable, 'node');
  // Same exact Linux cmdline entry required by stop-services, even from another cwd.
  assert.ok(args.includes(path.join(root, 'bridge/dist/index.js')));
  assert.equal(options.cwd, path.join(root, 'bridge'));
  assert.equal(options.env.HOME, home); assert.equal(options.env.USERPROFILE, home);
  assert.equal(options.env.FTOWN_DATA_DIR, path.join(home, '.ftown/data')); assert.equal(options.env.KEEP, 'preserved');
  assert.equal(options.detached, true); assert.equal(unreferenced, true);
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [[path.join(e2e, '.bridge.pid'), '901\n']]);
  assert.deepEqual(readiness, [['pointer', 901], ['presence', 'e2e-restart@ftown.test']]);
});
