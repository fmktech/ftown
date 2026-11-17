import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
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

test('normalizes trailing separators in a Claude working directory before resolving its project', async t => {
  const home = await mkdtemp(join(tmpdir(), 'native-sessions-')); t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, '.claude', 'projects', '-Work-my-project'); await mkdir(root, { recursive: true });
  await writeFile(join(root, 'session-123.jsonl'), JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'Canonical path session' } }));
  assert.deepEqual(await listNativeSessions('claude', '/Work/my project/', home), [
    { sessionId: 'session-123', timestamp: '2026-01-01T00:00:00Z', summary: 'Canonical path session' },
  ]);
});

test('returns an empty list when the harness directory does not exist', async t => {
  const home = await mkdtemp(join(tmpdir(), 'native-sessions-')); t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(await listNativeSessions('claude', '/missing', home), []);
  assert.deepEqual(await listNativeSessions('cursor', '/missing', home), []);
});

test('lists Claude sessions from the selected account config directory', async t => {
  const home = await mkdtemp(join(tmpdir(), 'native-sessions-')); t.after(() => rm(home, { recursive: true, force: true }));
  const configDir = join(home, '.claude-vitalsigns');
  const root = join(configDir, 'projects', '-Work-my-project'); await mkdir(root, { recursive: true });
  await writeFile(join(root, 'account-session.jsonl'), JSON.stringify({ type: 'user', timestamp: '2026-02-01T00:00:00Z', message: { content: 'Account session' } }));
  await mkdir(join(home, '.claude', 'projects', '-Work-my-project'), { recursive: true });
  await writeFile(join(home, '.claude', 'projects', '-Work-my-project', 'default-session.jsonl'), JSON.stringify({ type: 'user', timestamp: '2026-03-01T00:00:00Z', message: { content: 'Default session' } }));
  assert.deepEqual(await listNativeSessions('claude', '/Work/my project', home, configDir), [
    { sessionId: 'account-session', timestamp: '2026-02-01T00:00:00Z', summary: 'Account session' },
  ]);
});

test('returns an empty list for a missing selected-account projects directory', async t => {
  const home = await mkdtemp(join(tmpdir(), 'native-sessions-')); t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(await listNativeSessions('claude', '/Work/my project', home, join(home, '.claude-vitalsigns')), []);
});

test('keeps partial Claude results when a transcript cannot be read', async t => {
  const home = await mkdtemp(join(tmpdir(), 'native-sessions-')); t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, '.claude', 'projects', '-Work-my-project'); await mkdir(root, { recursive: true });
  await writeFile(join(root, 'good-session.jsonl'), JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'Readable session' } }));
  await mkdir(join(root, 'unreadable-session.jsonl'));
  const sessions = await listNativeSessions('claude', '/Work/my project', home);
  assert.equal(sessions.length, 2);
  assert.ok(sessions.some(session => session.sessionId === 'good-session' && session.summary === 'Readable session'));
  assert.ok(sessions.some(session => session.sessionId === 'unreadable-session' && session.summary === ''));
});

test('treats a non-readable Claude projects directory as an empty list', async t => {
  const home = await mkdtemp(join(tmpdir(), 'native-sessions-')); t.after(() => rm(home, { recursive: true, force: true }));
  const configDir = join(home, '.claude-vitalsigns'); await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'projects'), 'not a directory');
  assert.deepEqual(await listNativeSessions('claude', '/Work/my project', home, configDir), []);
});

test('lists Cursor chats from metadata and skips chats without a conversation', async t => {
  const home = await mkdtemp(join(tmpdir(), 'native-sessions-')); t.after(() => rm(home, { recursive: true, force: true }));
  const workingDir = '/work/project';
  const workspace = createHash('md5').update(workingDir).digest('hex');
  const root = join(home, '.cursor', 'chats', workspace);
  await mkdir(join(root, 'chat-one'), { recursive: true });
  await mkdir(join(root, 'chat-empty'), { recursive: true });
  await writeFile(join(root, 'chat-one', 'meta.json'), JSON.stringify({ title: 'Cursor title', updatedAtMs: 1700000000000, hasConversation: true }));
  await writeFile(join(root, 'chat-empty', 'meta.json'), JSON.stringify({ title: 'Unused', hasConversation: false }));
  assert.deepEqual(await listNativeSessions('cursor', workingDir, home), [
    { sessionId: 'chat-one', timestamp: '1700000000000', summary: 'Cursor title' },
  ]);
});
