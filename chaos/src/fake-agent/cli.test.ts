import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { epochClock, fileLogger, idsFromFile, parseArgs, run } from './cli.ts';

const dir = mkdtempSync(join(tmpdir(), 'chaos-cli-'));

test('epochClock: now() is ms since the epoch in the file', () => {
  const f = join(dir, 't0');
  writeFileSync(f, `${process.hrtime.bigint() - 5_000_000_000n}\n`);
  const t = epochClock(f).now();
  assert.ok(t >= 5000 && t < 5000 + 2000, String(t));
});

test('epochClock: missing or malformed file fails loudly', () => {
  assert.throws(() => epochClock(join(dir, 'nope')));
  const f = join(dir, 'bad');
  writeFileSync(f, 'abc');
  assert.throws(() => epochClock(f), /decimal/);
});

test('idsFromFile: role lookup, unknown and unreadable give null', () => {
  const f = join(dir, 'ids.json');
  writeFileSync(f, JSON.stringify({ child1: 'sid-1' }));
  assert.equal(idsFromFile(f)('child1'), 'sid-1');
  assert.equal(idsFromFile(f)('child2'), null);
  assert.equal(idsFromFile(join(dir, 'missing'))('child1'), null);
});

test('parseArgs ignores unknown arguments', () => {
  assert.deepEqual(parseArgs(['--foo', 'x', '--role', 'child1', '--bar', '--script=/s.json', 'extra']), { role: 'child1', script: '/s.json' });
  assert.deepEqual(parseArgs(['--resume', 'abc']), { role: undefined, script: undefined });
});

test('run: a command that outlives timeoutMs resolves with code 124', async () => {
  const r = await run(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { timeoutMs: 200 });
  assert.equal(r.code, 124);
  const ok = await run(process.execPath, ['-e', 'process.stdout.write("hi");process.exit(3)'], {});
  assert.deepEqual([ok.code, ok.stdout], [3, 'hi']);
});

test('fileLogger creates a missing log directory', () => {
  const d = join(dir, 'a', 'b');
  fileLogger(d, 'root', { now: () => 7, sleep: async () => undefined })({ ev: 'start', pid: 1 });
  assert.equal(readFileSync(join(d, 'root.jsonl'), 'utf8'), '{"t":7,"role":"root","e":{"ev":"start","pid":1}}\n');
});

test('main.ts stays alive after stdin closes, ignores unknown args, exits 143 on SIGTERM', async () => {
  const t0 = join(dir, 'main-t0');
  const script = join(dir, 'script.json');
  const logs = join(dir, 'main-logs');
  writeFileSync(t0, String(process.hrtime.bigint()));
  writeFileSync(script, JSON.stringify({ role: 'child1', steps: [], readMailOnNudge: true, answerRoutedQuestions: false }));
  const main = new URL('./main.ts', import.meta.url).pathname;
  const child = spawn(process.execPath, [main, '--role', 'child1', '--script', script, '--unknown', 'x'], {
    env: { ...process.env, CHAOS_T0_FILE: t0, CHAOS_AGENT_LOG_DIR: logs },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  let exitCode: number | null | undefined;
  child.on('exit', (code) => {
    exitCode = code;
  });
  child.stdin.end();
  const logFile = join(logs, 'child1.jsonl');
  for (let i = 0; i < 200 && !existsSync(logFile); i++) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(exitCode, undefined, 'still running after stdin closed');
  const exited = new Promise<void>((r) => child.on('exit', () => r()));
  child.kill('SIGTERM');
  await exited;
  assert.equal(exitCode, 143);
  rmSync(logs, { recursive: true });
});
