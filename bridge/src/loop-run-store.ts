import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import type { Loop, LoopRunRecord, Session } from './types.js';

interface LoopRunsFile {
  runs: LoopRunRecord[];
}

function runStorePath(): string {
  return join(homedir(), '.ftown', 'loop-runs.json');
}

function loadFile(): LoopRunsFile {
  try {
    const path = runStorePath();
    if (!existsSync(path)) return { runs: [] };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LoopRunsFile>;
    return { runs: Array.isArray(parsed.runs) ? parsed.runs : [] };
  } catch {
    return { runs: [] };
  }
}

function saveFile(data: LoopRunsFile): void {
  mkdirSync(join(homedir(), '.ftown'), { recursive: true, mode: 0o700 });
  const path = runStorePath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

export function listLoopRunRecords(loopId: string): LoopRunRecord[] {
  return loadFile()
    .runs.filter((run) => run.loopId === loopId)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export function getLoopRunRecord(runId: string): LoopRunRecord | undefined {
  return loadFile().runs.find((run) => run.id === runId || run.sessionId === runId);
}

export function upsertLoopRunRecord(record: LoopRunRecord): LoopRunRecord {
  const data = loadFile();
  const index = data.runs.findIndex((run) => run.id === record.id);
  if (index === -1) data.runs.push(record);
  else data.runs[index] = record;
  saveFile(data);
  return record;
}

export function deleteLoopRunRecords(loopId: string): void {
  const data = loadFile();
  const remaining = data.runs.filter((run) => run.loopId !== loopId);
  if (remaining.length === data.runs.length) return;
  data.runs = remaining;
  saveFile(data);
}

export function pruneLoopRunRecords(
  loopId: string,
  keep: number | null,
  preserveIds: Iterable<string | undefined> = [],
): void {
  if (keep == null) return;
  const preserve = new Set([...preserveIds].filter((id): id is string => Boolean(id)));
  const data = loadFile();
  const loopRuns = data.runs
    .filter((run) => run.loopId === loopId)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const kept = new Set<string>();
  for (const run of loopRuns) {
    if (preserve.has(run.id) || (run.sessionId && preserve.has(run.sessionId))) kept.add(run.id);
  }
  for (const run of loopRuns) {
    if (kept.size >= keep && !kept.has(run.id)) continue;
    kept.add(run.id);
  }
  data.runs = data.runs.filter((run) => run.loopId !== loopId || kept.has(run.id));
  saveFile(data);
}

export function recordForSession(loop: Loop, session: Session, startedAt = session.createdAt): LoopRunRecord {
  return {
    id: session.id,
    loopId: loop.id,
    bridgeId: loop.bridgeId,
    sessionId: session.id,
    name: session.name,
    status: session.status === 'error' ? 'error' : session.status === 'completed' ? 'ok' : 'running',
    startedAt,
    updatedAt: new Date().toISOString(),
    harness: loop.harness,
    workdir: session.workingDir ?? loop.workdir,
    task: session.prompt ?? loop.task,
    model: session.model ?? loop.model,
    sessionStatus: session.status,
    errorReason: session.errorReason,
  };
}

export function skippedRunRecord(loop: Loop, startedAt: string, details: string): LoopRunRecord {
  return {
    id: uuidv4(),
    loopId: loop.id,
    bridgeId: loop.bridgeId,
    name: `${loop.name} · skipped ${startedAt}`,
    status: 'skipped',
    startedAt,
    updatedAt: startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    harness: loop.harness,
    workdir: loop.workdir,
    task: loop.task,
    model: loop.model,
    logTail: details,
    logBytes: Buffer.byteLength(details, 'utf8'),
    logTruncated: false,
  };
}

function fallbackRecord(loopId: string, session: Session): LoopRunRecord {
  return {
    id: session.id,
    loopId,
    bridgeId: session.bridgeId,
    sessionId: session.id,
    name: session.name,
    status: session.status === 'error' ? 'error' : session.status === 'completed' ? 'ok' : 'running',
    startedAt: session.createdAt,
    updatedAt: session.updatedAt,
    harness:
      session.shellType === 'claude' ||
      session.shellType === 'cursor' ||
      session.shellType === 'codex' ||
      session.shellType === 'opencode' ||
      session.shellType === 'shell'
        ? session.shellType
        : undefined,
    workdir: session.workingDir,
    task: session.prompt,
    model: session.model,
    sessionStatus: session.status,
    errorReason: session.errorReason,
  };
}

export async function listLoopRunRecordsWithFallback(
  loopId: string,
  sessions: Session[],
  loadLog?: (sessionId: string) => Promise<string>,
): Promise<LoopRunRecord[]> {
  const records = listLoopRunRecords(loopId);
  const seenSessionIds = new Set(records.map((run) => run.sessionId).filter(Boolean));
  const seenIds = new Set(records.map((run) => run.id));

  for (const session of sessions) {
    if (session.loopId !== loopId) continue;
    if (seenIds.has(session.id) || seenSessionIds.has(session.id)) continue;
    const record = fallbackRecord(loopId, session);
    if (loadLog && (session.status === 'completed' || session.status === 'error')) {
      const log = await loadLog(session.id);
      const tail = log.length > 65_536 ? log.slice(-65_536) : log;
      record.logTail = tail;
      record.logBytes = Buffer.byteLength(log, 'utf8');
      record.logTruncated = Buffer.byteLength(log, 'utf8') > Buffer.byteLength(tail, 'utf8');
      record.finishedAt = session.updatedAt;
      record.durationMs = Math.max(0, Date.parse(session.updatedAt) - Date.parse(session.createdAt));
    }
    records.push(record);
  }

  return records.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}
