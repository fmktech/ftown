import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { installClaudeHooks } from './hook-installer.js';
import { ASK_HOOK_TIMEOUT_SECONDS } from './attention-prompt-protocol.js';

test('setup reports invalid user settings as failure without replacing them', () => {
  const previous = process.env.HOME; const home = mkdtempSync(join(tmpdir(), 'ftown-hooks-')); process.env.HOME = home;
  try {
    const path = join(home, '.claude/settings.json'); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '{invalid');
    assert.equal(installClaudeHooks('/tmp/notify.sh'), false);
    assert.equal(readFileSync(path, 'utf8'), '{invalid');
    writeFileSync(path, '{"custom":"keep"}');
    assert.equal(installClaudeHooks('/tmp/notify.sh'), true);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).custom, 'keep');
  } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; rmSync(home, { recursive: true, force: true }); }
});

function withTempHome(run: (home: string, settingsPath: string) => void): void {
  const previous = process.env.HOME; const home = mkdtempSync(join(tmpdir(), 'ftown-hooks-ask-')); process.env.HOME = home;
  try {
    const settingsPath = join(home, '.claude/settings.json');
    run(home, settingsPath);
  } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; rmSync(home, { recursive: true, force: true }); }
}

type AnyHookEntry = { matcher?: string; hooks?: Array<Record<string, unknown>> };

function readPreToolUse(settingsPath: string): AnyHookEntry[] {
  const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks: { PreToolUse: AnyHookEntry[] } };
  return parsed.hooks.PreToolUse;
}

function askEntries(entries: AnyHookEntry[]): Array<{ matcher?: string; hook: Record<string, unknown> }> {
  const found: Array<{ matcher?: string; hook: Record<string, unknown> }> = [];
  for (const entry of entries) {
    for (const hook of entry.hooks ?? []) {
      if (typeof hook.command === 'string' && hook.command.includes('ask-hook')) found.push({ matcher: entry.matcher, hook });
    }
  }
  return found;
}

test('fresh install adds an AskUserQuestion PreToolUse ask-hook with the contract timeout and no async', () => {
  withTempHome((home, settingsPath) => {
    assert.equal(installClaudeHooks('/tmp/notify.sh'), true);
    const found = askEntries(readPreToolUse(settingsPath));
    assert.equal(found.length, 1);
    assert.equal(found[0].matcher, 'AskUserQuestion');
    assert.equal(found[0].hook.type, 'command');
    assert.equal(found[0].hook.command, `${join(home, '.ftown', 'bin', 'ftown-harness')} ask-hook`);
    assert.equal(found[0].hook.timeout, ASK_HOOK_TIMEOUT_SECONDS);
    assert.equal('async' in found[0].hook, false);
  });
});

test('second install run leaves exactly one ask-hook entry and an identical settings file', () => {
  withTempHome((home, settingsPath) => {
    const notify = join(home, '.ftown', 'hooks', 'notify.sh');
    assert.equal(installClaudeHooks(notify), true);
    const first = readFileSync(settingsPath, 'utf8');
    assert.equal(installClaudeHooks(notify), true);
    assert.equal(readFileSync(settingsPath, 'utf8'), first);
    assert.equal(askEntries(readPreToolUse(settingsPath)).length, 1);
  });
});

test('install repairs a wrong timeout, a stray async flag, and a bare command path on the ask-hook entry', () => {
  withTempHome((home, settingsPath) => {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'ftown-harness ask-hook', timeout: 30, async: true }] }] },
    }));
    assert.equal(installClaudeHooks(join(home, '.ftown', 'hooks', 'notify.sh')), true);
    const found = askEntries(readPreToolUse(settingsPath));
    assert.equal(found.length, 1);
    assert.equal(found[0].matcher, 'AskUserQuestion');
    assert.equal(found[0].hook.command, `${join(home, '.ftown', 'bin', 'ftown-harness')} ask-hook`);
    assert.equal(found[0].hook.timeout, ASK_HOOK_TIMEOUT_SECONDS);
    assert.equal('async' in found[0].hook, false);
  });
});

test('install keeps an already-correct ask-hook entry and leaves the settings file unchanged', () => {
  withTempHome((home, settingsPath) => {
    const notify = join(home, '.ftown', 'hooks', 'notify.sh');
    assert.equal(installClaudeHooks(notify), true);
    const before = readFileSync(settingsPath, 'utf8');
    assert.equal(installClaudeHooks(notify), true);
    assert.equal(readFileSync(settingsPath, 'utf8'), before);
    const found = askEntries(readPreToolUse(settingsPath));
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].hook, {
      type: 'command',
      command: `${join(home, '.ftown', 'bin', 'ftown-harness')} ask-hook`,
      timeout: ASK_HOOK_TIMEOUT_SECONDS,
    });
  });
});

test('install moves an ask-hook misplaced under matcher "" into the AskUserQuestion group', () => {
  withTempHome((home, settingsPath) => {
    const notify = join(home, '.ftown', 'hooks', 'notify.sh');
    const askCommand = `${join(home, '.ftown', 'bin', 'ftown-harness')} ask-hook`;
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: askCommand, timeout: ASK_HOOK_TIMEOUT_SECONDS }] }] },
    }));
    assert.equal(installClaudeHooks(notify), true);
    const entries = readPreToolUse(settingsPath);
    assert.equal(entries.some((e) => (e.matcher ?? '') === '' && (e.hooks ?? []).some((h) => String(h.command).includes('ask-hook'))), false);
    const found = askEntries(entries);
    assert.equal(found.length, 1);
    assert.equal(found[0].matcher, 'AskUserQuestion');
    assert.equal(found[0].hook.command, askCommand);
    assert.equal(found[0].hook.timeout, ASK_HOOK_TIMEOUT_SECONDS);
    const first = readFileSync(settingsPath, 'utf8');
    assert.equal(installClaudeHooks(notify), true);
    assert.equal(readFileSync(settingsPath, 'utf8'), first);
  });
});

test('install removes only the misplaced ask-hook from a shared "" group and keeps the user hook', () => {
  withTempHome((home, settingsPath) => {
    const notify = join(home, '.ftown', 'hooks', 'notify.sh');
    const askCommand = `${join(home, '.ftown', 'bin', 'ftown-harness')} ask-hook`;
    const userHook = { type: 'command', command: '/opt/user/guard.sh', timeout: 5 };
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: '', hooks: [userHook, { type: 'command', command: askCommand, timeout: ASK_HOOK_TIMEOUT_SECONDS }] }] },
    }));
    assert.equal(installClaudeHooks(notify), true);
    const entries = readPreToolUse(settingsPath);
    const plainGroup = entries.find((e) => (e.matcher ?? '') === '' && (e.hooks ?? []).some((h) => h.command === '/opt/user/guard.sh'));
    assert.ok(plainGroup);
    assert.deepEqual(plainGroup.hooks, [userHook]);
    assert.equal(askEntries(entries).length, 1);
    assert.equal(askEntries(entries)[0].matcher, 'AskUserQuestion');
    const first = readFileSync(settingsPath, 'utf8');
    assert.equal(installClaudeHooks(notify), true);
    assert.equal(readFileSync(settingsPath, 'utf8'), first);
  });
});

test('install leaves user PreToolUse hooks and other ftown hooks untouched', () => {
  withTempHome((home, settingsPath) => {
    const userBash = { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/my-audit.sh', timeout: 5 }] };
    const userAll = { matcher: '', hooks: [{ type: 'command', command: '/opt/user/guard.sh' }] };
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [userBash, userAll] } }));
    assert.equal(installClaudeHooks(join(home, '.ftown', 'hooks', 'notify.sh')), true);
    const entries = readPreToolUse(settingsPath);
    assert.deepEqual(entries[0], userBash);
    assert.deepEqual(entries[1], userAll);
    assert.equal(askEntries(entries).length, 1);
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks: Record<string, AnyHookEntry[]> };
    const stopCommands = (parsed.hooks.Stop ?? []).flatMap((e) => e.hooks ?? []).map((h) => h.command);
    assert.ok(stopCommands.some((c) => typeof c === 'string' && c.includes('hook-pump')));
    assert.equal(stopCommands.some((c) => typeof c === 'string' && c.includes('ask-hook')), false);
  });
});
