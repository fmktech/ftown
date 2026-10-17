// Root-run focused integration check. No cloud, real bridge, native agent or DB.
// Run from anywhere after `cd bridge && npm run build`:
// node docs/investigations/simplify-agent-surface/smoke.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runFile = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bridge = join(root, 'bridge');
const temporary = mkdtempSync(join(tmpdir(), 'ftown-agent-surface-'));
const home = join(temporary, 'home');
mkdirSync(home);
const savedHome = process.env.HOME;
const savedProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;
const load = (name) => import(pathToFileURL(join(bridge, 'dist', name)).href);
const base = '4f6811c215865c839f9b6a9f3e277346bbde4b74';
const shipped = async (path) => (await runFile('git', ['show', `${base}:${path}`], { cwd: root })).stdout;
const ftownDir = join(home, '.ftown');
const requests = [];
const fixtureSession = { id: 'fixture-session', name: 'fixture', status: 'running', shellType: 'shell', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
  assert.equal(req.headers.authorization, 'Bearer local-smoke-only');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && req.url === '/api/sessions') res.end(JSON.stringify({ sessions: [fixtureSession] }));
  else if (req.method === 'POST' && req.url === '/api/sessions') res.end(JSON.stringify({ session: { ...fixtureSession, ...JSON.parse(body) } }));
  else if (req.method === 'GET' && req.url?.startsWith('/api/sessions/fixture-session/screen?')) res.end(JSON.stringify({ lines: ['fixture output'] }));
  else { res.statusCode = 404; res.end(JSON.stringify({ error: 'fixture-only endpoint' })); }
});
let listening = false;
try {
  assert.equal(home.startsWith(temporary + '/'), true);
  const { installFtownSessionsCli } = await load('install-ftown-cli.js');
  const { installFtownCommandCli } = await load('install-ftown-command-cli.js');
  const { installFtownEnvCli } = await load('install-ftown-env-cli.js');
  const { installHarness, writeHarnessAgentGuide } = await load('harness-installer.js');
  const { installFtownSkill, retireBundledAgentAssets } = await load('install-ftown-skill.js');
  const { RETIRED_FTICKET_ASSETS } = await load('retired-skill-assets.js');
  const { default: ts } = await import(pathToFileURL(join(bridge, 'node_modules/typescript/lib/typescript.js')).href);
  const canonical = join(ftownDir, 'skills', 'fticket');
  // Reconstruct only immutable shipped assets in this temporary HOME.
  for (const [path, signature] of Object.entries(RETIRED_FTICKET_ASSETS)) {
    const target = join(canonical, path);
    if (signature === 'directory') mkdirSync(target, { recursive: true });
    else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, await shipped(`bridge/skills/fticket/${path}`)); }
  }
  for (const dir of ['.agents', '.claude']) {
    mkdirSync(join(home, dir, 'skills'), { recursive: true });
    symlinkSync('../../.ftown/skills/fticket', join(home, dir, 'skills', 'fticket'));
  }
  const skill = join(ftownDir, 'skills', 'ftown');
  for (const path of ['references/workflows.md', 'scripts/example.flow.mjs']) {
    mkdirSync(dirname(join(skill, path)), { recursive: true });
    writeFileSync(join(skill, path), await shipped(`bridge/skills/ftown/${path}`));
  }
  const config = ts.parseJsonConfigFileContent(JSON.parse(readFileSync(join(bridge, 'tsconfig.json'), 'utf8')), ts.sys, bridge);
  for (const [source, destination] of [['workflow-runner.ts', 'workflow-runner.js'], ['workflow-runner-cli.ts', 'ftown-workflows-cli.js']]) {
    const output = ts.transpileModule(await shipped(`bridge/src/${source}`), { compilerOptions: { ...config.options, module: ts.ModuleKind.ES2022 }, fileName: source }).outputText;
    writeFileSync(join(ftownDir, destination), output);
  }
  writeFileSync(join(ftownDir, 'ftown-workflows'), `#!/usr/bin/env bash
set -euo pipefail
exec node "${join(ftownDir, 'ftown-workflows-cli.js')}" "$@"
`);
  mkdirSync(join(ftownDir, 'workflows', 'saved-run'), { recursive: true });
  writeFileSync(join(ftownDir, 'workflows', 'saved-run', 'result.json'), 'keep run data');
  writeFileSync(join(ftownDir, 'claude-trust.js'), 'keep shared runtime');
  retireBundledAgentAssets();
  for (const path of ['skills/fticket', 'skills/ftown/references/workflows.md', 'skills/ftown/scripts/example.flow.mjs', 'workflow-runner.js', 'ftown-workflows-cli.js', 'ftown-workflows']) assert.equal(existsSync(join(ftownDir, path)), false, path);
  assert.equal(readFileSync(join(ftownDir, 'workflows', 'saved-run', 'result.json'), 'utf8'), 'keep run data');
  assert.equal(readFileSync(join(ftownDir, 'claude-trust.js'), 'utf8'), 'keep shared runtime');
  mkdirSync(canonical); writeFileSync(join(canonical, 'SKILL.md'), 'independent customized skill');
  symlinkSync('../../.ftown/skills/fticket', join(home, '.agents', 'skills', 'fticket'));
  writeFileSync(join(ftownDir, 'ftown-workflows'), 'custom launcher');
  retireBundledAgentAssets();
  assert.equal(readFileSync(join(canonical, 'SKILL.md'), 'utf8'), 'independent customized skill');
  assert.equal(lstatSync(join(home, '.agents', 'skills', 'fticket')).isSymbolicLink(), true);
  assert.equal(readFileSync(join(ftownDir, 'ftown-workflows'), 'utf8'), 'custom launcher');

  installFtownSessionsCli(join(bridge, 'dist/ftown-sessions-cli.js'));
  installFtownEnvCli(join(bridge, 'dist/ftown-env-cli.js'));
  const command = installFtownCommandCli(join(bridge, 'dist/ftown-cli.js'));
  const harness = installHarness(join(bridge, 'dist/harness-cli.js'));
  installFtownSkill('ftown', join(bridge, 'skills/ftown'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  listening = true;
  const port = server.address().port;
  writeFileSync(join(ftownDir, 'bridge.json'), JSON.stringify({ port, token: 'local-smoke-only', bridgeId: 'isolated-fixture' }));
  writeHarnessAgentGuide({ wrapperPath: harness.wrapperPath, port });
  const env = { HOME: home, USERPROFILE: home, PATH: `${ftownDir}:${dirname(process.execPath)}:/usr/bin:/bin`, FTOWN_SESSION_ID: 'fixture-parent' };
  const invoke = async (file, args, code = 0) => {
    try {
      const result = await runFile(file, args, { env, cwd: temporary, timeout: 10000 });
      assert.equal(code, 0, `expected exit ${code}: ${args.join(' ')}`);
      return result;
    } catch (error) {
      assert.equal(error.code, code, `${args.join(' ')}: ${error.stderr ?? error.message}`);
      return { stdout: error.stdout, stderr: error.stderr };
    }
  };
  const help = await invoke(command, ['--help']);
  assert.match(help.stdout, /env\|sessions\|harness/); assert.doesNotMatch(help.stdout, /workflows/);
  assert.match((await invoke(command, ['sessions', '--help'])).stderr, /Usage: ftown sessions/);
  assert.match((await invoke(command, ['harness', '--help'])).stdout, /ftown harness/);
  assert.match((await invoke(command, ['env', '--help'])).stderr, /Usage: ftown env/);
  assert.deepEqual(JSON.parse((await invoke(command, ['sessions', 'list'])).stdout).sessions, [fixtureSession]);
  assert.deepEqual(JSON.parse((await invoke(join(ftownDir, 'ftown-sessions'), ['list'])).stdout).sessions, [fixtureSession]);
  assert.equal(JSON.parse((await invoke(command, ['harness', '--json', 'status'])).stdout).bridge, 'up');
  assert.equal(JSON.parse((await invoke(harness.wrapperPath, ['--json', 'status'])).stdout).bridge, 'up');
  await invoke(command, ['env', 'ls']); await invoke(join(ftownDir, 'ftown-env'), ['ls']);
  const task = 'keep spaces, "quotes", $literal and Unicode é';
  await invoke(command, ['sessions', 'create', '--prompt', task, '--name', 'fixture child', '--parent', '--workdir', temporary]);
  const creation = requests.find((request) => request.method === 'POST');
  assert.equal(creation.body.prompt, task); assert.equal(creation.body.name, 'fixture child'); assert.equal(creation.body.parentSessionId, true);
  await invoke(command, ['sessions', 'screen', 'fixture-session', '--limit', '7']);
  assert.ok(requests.some((request) => request.url.includes('limit=7')));
  assert.match((await invoke(command, ['workflows', 'run', 'anything'], 1)).stderr, /Unknown subcommand/);
  await invoke(command, ['sessions', 'bogus'], 1); // real target's failure propagates
  const guide = readFileSync(join(ftownDir, 'harness-agent.md'), 'utf8');
  assert.ok(guide.length < 900); assert.match(guide, /skills\/ftown\/SKILL\.md/);
  console.log(JSON.stringify({ result: 'PASS', boundary: 'real installed CLI dispatchers + loopback fixture API; no real bridge/native agents', requests: requests.length, temporaryHome: home, cleanup: 'finally closes fixture and removes temporary HOME' }));
} finally {
  if (listening) await new Promise((resolve) => server.close(resolve));
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  rmSync(temporary, { recursive: true, force: true });
}
