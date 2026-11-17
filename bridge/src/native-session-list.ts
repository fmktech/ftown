import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeProjectSlug } from './usage-collector.js';

export interface NativeSessionSummary { sessionId: string; timestamp: string; summary: string }
export type NativeSessionHarness = 'claude' | 'cursor';

async function listClaude(workingDir: string, home: string, configDir?: string): Promise<NativeSessionSummary[]> {
  const root = join(configDir ?? join(home, '.claude'), 'projects', claudeProjectSlug(workingDir));
  let names: string[];
  try { names = await readdir(root); } catch { return []; }
  const results: NativeSessionSummary[] = [];
  for (const name of names.filter(value => value.endsWith('.jsonl'))) {
    const sessionId = name.slice(0, -6);
    if (!sessionId || !sessionId.includes('-')) continue;
    let timestamp = '', summary = '';
    try {
      for (const line of (await readFile(join(root, name), 'utf8')).split('\n')) {
        if (!line.trim()) continue;
        let entry: Record<string, unknown>;
        try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (!timestamp && typeof entry.timestamp === 'string') timestamp = entry.timestamp;
        if (entry.type !== 'human' && entry.type !== 'user') continue;
        const message = entry.message && typeof entry.message === 'object' ? entry.message as Record<string, unknown> : {};
        let content = entry.content ?? message.content;
        if (Array.isArray(content)) content = content.filter(part => part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text').map(part => (part as Record<string, unknown>).text).filter((part): part is string => typeof part === 'string').join(' ');
        if (typeof content === 'string' && content.trim()) summary = content.trim().slice(0, 100).replaceAll('|', ' ');
      }
    } catch { /* Ignore unreadable or partially written transcripts. */ }
    results.push({ sessionId, timestamp, summary });
  }
  return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 20);
}

function readCursorSqliteSummary(path: string): { summary: string; timestamp: string } {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value?: unknown } | undefined;
    if (!row?.value) return { summary: '', timestamp: '' };
    let raw = row.value;
    if (typeof raw === 'string' && /^[0-9a-f]{32,}$/i.test(raw)) raw = Buffer.from(raw, 'hex').toString('utf8');
    const meta = JSON.parse(String(raw)) as Record<string, unknown>;
    return { summary: typeof meta.name === 'string' ? meta.name.trim() : '', timestamp: String(meta.createdAt ?? meta.updatedAt ?? '') };
  } catch { return { summary: '', timestamp: '' }; }
  finally { db?.close(); }
}

async function listCursor(workingDir: string, home: string): Promise<NativeSessionSummary[]> {
  const root = join(home, '.cursor', 'chats', createHash('md5').update(resolve(workingDir)).digest('hex'));
  let entries: import('node:fs').Dirent[];
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const results: NativeSessionSummary[] = [];
  for (const sessionId of entries.filter(entry => entry.isDirectory()).map(entry => entry.name)) {
    const dir = join(root, sessionId);
    let timestamp = '', summary = '';
    try {
      const metadata = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as Record<string, unknown>;
      if (metadata.hasConversation === false) continue;
      summary = typeof metadata.title === 'string' ? metadata.title.trim() : '';
      timestamp = String(metadata.updatedAtMs ?? metadata.createdAtMs ?? '');
    } catch { /* Metadata is optional; inspect store.db below. */ }
    if (!summary) {
      const sqlite = readCursorSqliteSummary(join(dir, 'store.db'));
      summary = sqlite.summary; if (!timestamp) timestamp = sqlite.timestamp;
    }
    if (summary === 'Agent' || summary === 'New Agent') summary = '';
    results.push({ sessionId, timestamp, summary });
  }
  return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 20);
}

export function listNativeSessions(harness: NativeSessionHarness, workingDir: string, home = homedir(), claudeConfigDir?: string): Promise<NativeSessionSummary[]> {
  return harness === 'claude' ? listClaude(workingDir, home, claudeConfigDir) : listCursor(workingDir, home);
}
