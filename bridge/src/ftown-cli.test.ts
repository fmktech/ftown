import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runFtown, usage } from './ftown-cli.js';

async function capture(run: () => Promise<unknown>): Promise<string> {
  let text = ''; const originalOut = process.stdout.write; const originalError = process.stderr.write;
  const write = ((chunk: string | Uint8Array) => { text += chunk.toString(); return true; }) as typeof process.stdout.write;
  process.stdout.write = write; process.stderr.write = write;
  try { await run(); return text; } finally { process.stdout.write = originalOut; process.stderr.write = originalError; }
}

describe('in-process canonical commands', () => {
  it('discovers setup and groups, rejecting the retired workflow route', async () => {
    assert.match(usage(), /setup\|start\|sessions\|harness\|env/);
    assert.doesNotMatch(usage(), /workflows/);
    let code: number | undefined;
    await capture(async () => { code = await runFtown(['workflows']); });
    assert.equal(code, 1);
  });
  it('routes canonical start through the read-only readiness gate before bridge loading', async () => {
    const previous = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), 'ftown-start-unready-'));
    process.env.HOME = home;
    try {
      for (const argv of [[], ['--local'], ['start', '--solo']]) {
        await assert.rejects(runFtown(argv), /npx ftown@[\d.]+ setup/);
      }
      assert.equal(existsSync(join(home, '.ftown')), false);
    } finally {
      if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('forwards default/root flags and explicit start to the same start route unchanged', async () => {
    const calls: string[][] = [];
    const start = async (argv: string[]) => { calls.push(argv); return 7; };
    assert.equal(await runFtown([], start), 7);
    const rootOptions = ['--local', '--api-url', 'http://127.0.0.1', '--port', '8040'];
    assert.equal(await runFtown(rootOptions, start), 7);
    assert.equal(await runFtown(['--solo'], start), 7);
    assert.equal(await runFtown(['start', ...rootOptions], start), 7);
    assert.deepEqual(calls, [[], rootOptions, ['--solo'], rootOptions]);
  });
  it('keeps explicit help read-only and unknown positional commands out of startup', async () => {
    let started = false;
    const start = async () => { started = true; throw new Error('must not start'); };
    const previous = process.env.HOME; const home = mkdtempSync(join(tmpdir(), 'ftown-root-help-'));
    process.env.HOME = home;
    try {
      const text = await capture(async () => {
        for (const help of ['--help', '-h', 'help']) assert.equal(await runFtown([help], start), 0);
        assert.equal(await runFtown(['not-a-command'], start), 1);
      });
      assert.match(text, /With no subcommand, start the bridge/);
      assert.match(text, /Unknown subcommand "not-a-command"/);
      assert.equal(started, false); assert.equal(existsSync(join(home, '.ftown')), false);
    } finally {
      if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('runs repeated harness parsers and env help without import/exit side effects', async () => {
    const text = await capture(async () => {
      assert.equal(await runFtown(['harness', '--help']), 0);
      assert.equal(await runFtown(['harness', '--help']), 0);
      assert.equal(await runFtown(['env', '--help']), 0);
    });
    assert.equal((text.match(/Usage: ftown harness/g) ?? []).length, 2);
    assert.match(text, /Usage: ftown env/);
  });
  it('shares the callers fetch, HOME and process for session commands', async () => {
    const previous = process.env.HOME; const home = mkdtempSync(join(tmpdir(), 'ftown-cli-'));
    const original = globalThis.fetch;
    process.env.HOME = home;
    try {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(join(home, '.ftown')); writeFileSync(join(home, '.ftown/bridge.json'), '{"port":1234,"token":"test"}');
      const requests: string[] = [];
      globalThis.fetch = (async (url) => { requests.push(String(url)); return new Response('{"sessions":[]}', { status: 200 }); }) as typeof fetch;
      await capture(async () => { assert.equal(await runFtown(['sessions', 'list']), 0); });
      assert.deepEqual(requests, ['http://127.0.0.1:1234/api/sessions']);
    } finally { globalThis.fetch = original; if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; rmSync(home, { recursive: true, force: true }); }
  });
});

describe('CLI entry recognition', () => {
  it('recognizes physical, parent-symlink and npm-bin paths without running on import', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const { isCliEntry } = await import('./ftown-cli.js');
    const temporary = mkdtempSync(join(tmpdir(), 'ftown-entry-'));
    try {
      const dist = join(temporary, 'node_modules', 'ftown-bridge', 'dist');
      const bin = join(temporary, 'node_modules', '.bin');
      mkdirSync(dist, { recursive: true }); mkdirSync(bin);
      const target = join(dist, 'ftown-cli.js'); writeFileSync(target, 'export {};');
      const npmBin = join(bin, 'ftown'); symlinkSync('../ftown-bridge/dist/ftown-cli.js', npmBin);
      const parentLink = join(temporary, 'linked-dist'); symlinkSync(dist, parentLink);
      const moduleUrl = pathToFileURL(realpathSync(target)).href;
      assert.equal(isCliEntry(moduleUrl, target), true);
      assert.equal(isCliEntry(moduleUrl, npmBin), true);
      assert.equal(isCliEntry(moduleUrl, join(parentLink, 'ftown-cli.js')), true);
      assert.equal(isCliEntry('file:///different-module.js', npmBin), false);
      assert.equal(isCliEntry(moduleUrl, undefined), false);
      assert.equal(isCliEntry(moduleUrl, join(temporary, 'missing')), false);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
});
