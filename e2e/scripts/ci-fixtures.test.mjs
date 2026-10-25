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
