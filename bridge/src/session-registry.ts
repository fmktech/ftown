import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

interface RegistryData {
  byWorkspace: Record<string, string>;
  byConversation: Record<string, string>;
}

const REGISTRY_PATH = join(homedir(), '.ftown', 'session-registry.json');

function loadRegistry(): RegistryData {
  try {
    if (!existsSync(REGISTRY_PATH)) {
      return { byWorkspace: {}, byConversation: {} };
    }
    const parsed = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Partial<RegistryData>;
    return {
      byWorkspace: parsed.byWorkspace ?? {},
      byConversation: parsed.byConversation ?? {},
    };
  } catch {
    return { byWorkspace: {}, byConversation: {} };
  }
}

function saveRegistry(data: RegistryData): void {
  mkdirSync(join(homedir(), '.ftown'), { recursive: true, mode: 0o700 });
  const tmp = `${REGISTRY_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, REGISTRY_PATH);
}

export function registerSessionWorkspace(sessionId: string, workingDir?: string): void {
  if (!workingDir?.trim()) return;
  const data = loadRegistry();
  data.byWorkspace[resolve(workingDir.trim())] = sessionId;
  saveRegistry(data);
}

export function registerSessionConversation(sessionId: string, conversationId: string): void {
  if (!conversationId) return;
  const data = loadRegistry();
  data.byConversation[conversationId] = sessionId;
  saveRegistry(data);
}

export function unregisterSession(sessionId: string): void {
  const data = loadRegistry();
  for (const [path, id] of Object.entries(data.byWorkspace)) {
    if (id === sessionId) delete data.byWorkspace[path];
  }
  for (const [conv, id] of Object.entries(data.byConversation)) {
    if (id === sessionId) delete data.byConversation[conv];
  }
  saveRegistry(data);
}

export function resolveSessionIdFromHookPayload(payload: Record<string, unknown>): string | undefined {
  const ftownId = payload.ftown_session_id;
  if (typeof ftownId === 'string' && ftownId) return ftownId;

  const data = loadRegistry();
  const conversationId = payload.conversation_id;
  if (typeof conversationId === 'string' && conversationId) {
    const byConv = data.byConversation[conversationId];
    if (byConv) return byConv;
  }

  const roots = payload.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === 'string' && roots[0]) {
    const byWs = data.byWorkspace[resolve(roots[0])];
    if (byWs) return byWs;
  }

  return undefined;
}
