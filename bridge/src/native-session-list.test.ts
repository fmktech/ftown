import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listNativeSessions } from './native-session-list.js';

test('lists and summarizes Claude transcripts for the working directory', async t => {
  const home = await mkdtemp(join(tmpdir(), 'native-sessions-')); t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, '.claude', 'projects', '-Work-my-project'); await mkdir(root, { recursive: true });
  await writeFile(join(root, 'session-123.jsonl'), [
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'text', text: 'Fix | this' }] } }),
  ].join('\n'));
  assert.deepEqual(await listNativeSessions('claude', '/Work/my project', home), [{ sessionId: 'session-123', timestamp: '2026-01-01T00:00:00Z', summary: 'Fix   this' }]);
});

test('returns an empty list when the harness directory does not exist', async t => {
  const home = await mkdtemp(join(tmpdir(), 'native-sessions-')); t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(await listNativeSessions('claude', '/missing', home), []);
  assert.deepEqual(await listNativeSessions('cursor', '/missing', home), []);
});
