import assert from 'node:assert/strict';
import { it } from 'node:test';
import { directShellCommand } from './direct-shell.js';
import { shellQuote } from './harness-registry.js';
import { ProcessRunner } from './claude-runner.js';

it('keeps the Unix login shell launch', () => {
  assert.deepEqual(directShellCommand('echo hello', 'darwin'), {
    file: '/bin/zsh', args: ['-l', '-c', 'echo hello'],
  });
});

it('uses Windows PowerShell and preserves Unicode and quotes in encoded commands', () => {
  const command = "Write-Output 'olá; $HOME & today''s diff'";
  const shell = directShellCommand(command, 'win32', { SystemRoot: 'D:\\Windows' });
  assert.equal(shell.file, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(Buffer.from(shell.args.at(-1)!, 'base64').toString('utf16le'),
    `$ErrorActionPreference = 'Stop'\n${command}\nexit $LASTEXITCODE`);
  assert.equal(shellQuote("today's diff", 'win32'), "'today''s diff'");
  assert.equal(shellQuote("today's diff", 'linux'), "'today'\\''s diff'");
});

async function run(command: string): Promise<{ output: string; error?: Error }> {
  const runner = new ProcessRunner();
  assert.equal(runner.getPreferredRuntime(), 'direct');
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { runner.stopAll(); reject(new Error('PTY launch timed out')); }, 15000);
    runner.on('data', (_id, data) => { output += data; });
    runner.on('complete', () => { clearTimeout(timer); resolve({ output }); });
    runner.on('error', (_id, error) => { clearTimeout(timer); resolve({ output, error }); });
    runner.run('windows-smoke', command);
  });
}

it('runs a real Windows PTY with quoted arguments', { skip: process.platform !== 'win32' }, async () => {
  const result = await run(`Write-Output ${shellQuote("today's diff; $HOME & literal")}`);
  assert.equal(result.error, undefined);
  assert.match(result.output, /today's diff; \$HOME & literal/);
});

it('reports native nonzero exits', { skip: process.platform !== 'win32' }, async () => {
  const result = await run('cmd.exe /d /c exit 7');
  assert.match(result.error?.message ?? '', /code 7/);
});

it('reports missing commands instead of success', { skip: process.platform !== 'win32' }, async () => {
  const result = await run('ftown_nonexistent_test_command');
  assert.ok(result.error);
});
