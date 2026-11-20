import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installInstructions, instructionPath, pullGlobal, readRevision, readInstructions } from './instructions.js';

test('setup preserves profile instructions and local edits across repairs', t => {
  const home = mkdtempSync(join(tmpdir(), 'ftown-instructions-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { CODEX_HOME: join(home, 'codex account'), CLAUDE_CONFIG_DIR: join(home, 'claude account') };
  mkdirSync(env.CODEX_HOME);
  const agents = join(env.CODEX_HOME, 'AGENTS.md');
  writeFileSync(agents, 'Original');
  installInstructions(home, env);
  writeFileSync(instructionPath('bridge', home), 'Machine guidance');
  installInstructions(home, env);
  for (const file of [agents, join(env.CLAUDE_CONFIG_DIR, 'CLAUDE.md')]) {
    const content = readFileSync(file, 'utf8');
    for (const scope of ['global', 'bridge'] as const) assert.equal(content.split(instructionPath(scope, home)).length, 2);
  }
  assert.ok(readFileSync(agents, 'utf8').startsWith('Original\n'));
  assert.equal(readInstructions('bridge', home), 'Machine guidance');
});

test('global pulls converge on the latest edit across relays, ties and deletions', t => {
  const home = mkdtempSync(join(tmpdir(), 'ftown-revisions-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  installInstructions(home, {});
  assert.equal(readRevision('global', home).version, 0);
  const version = 1775000123456;
  pullGlobal({ text: 'a', version }, home);
  pullGlobal({ text: 'z', version: version - 1 }, home);
  assert.deepEqual(readRevision('global', home), { text: 'a', version });
  pullGlobal({ text: 'b', version }, home);
  pullGlobal({ text: 'a', version }, home);
  assert.deepEqual(readRevision('global', home), { text: 'b', version });
  pullGlobal({ text: 'b', version: version + 1 }, home);
  assert.equal(readRevision('global', home).version, version + 1);
  pullGlobal({ text: '', version: version + 2 }, home);
  assert.deepEqual(readRevision('global', home), { text: '', version: version + 2 });
});
