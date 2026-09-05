import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

interface RegistryData {
  byWorkspace: Record<string, string>;
  byConversation: Record<string, string>;
}

/**
 * Instance ".ftown home" for `session-registry.json`, injected once at bridge
 * startup via `configureSessionRegistryHome()` (index.ts passes
 * `resolveFtownHome(dataDir)`): the DEFAULT data dir keeps `$HOME/.ftown`, a
 * non-default `--data-dir` gets its own home so a co-resident bridge's registry
 * is never touched. Unconfigured (unit tests / default install) it falls back to
 * `join(homedir(), '.ftown')` resolved at call time — a test's $HOME override
 * still redirects every read/write. Previously a module-level const computed at
 * import time; now call-time so injection (and the $HOME override) take effect.
 */
let configuredFtownHome: string | undefined;

/** Inject the instance ".ftown home" once at startup (see above). */
export function configureSessionRegistryHome(home: string | undefined): void {
  configuredFtownHome = home;
}

function ftownHome(): string {
  return configuredFtownHome ?? join(homedir(), '.ftown');
}

function registryPath(): string {
  return join(ftownHome(), 'session-registry.json');
}

function loadRegistry(): RegistryData {
  try {
    if (!existsSync(registryPath())) {
      return { byWorkspace: {}, byConversation: {} };
    }
    const parsed = JSON.parse(readFileSync(registryPath(), 'utf8')) as Partial<RegistryData>;
    return {
      byWorkspace: parsed.byWorkspace ?? {},
      byConversation: parsed.byConversation ?? {},
    };
  } catch {
    return { byWorkspace: {}, byConversation: {} };
  }
}

function saveRegistry(data: RegistryData): void {
  mkdirSync(ftownHome(), { recursive: true, mode: 0o700 });
  const path = registryPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
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

export function resolveSessionIdByConversation(conversationId: string): string | undefined {
  if (!conversationId) return undefined;
  return loadRegistry().byConversation[conversationId];
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

/**
 * How a hook payload was attributed to a ftown session. 'workspace' is an
 * ambiguous directory fallback — it may match a foreign agent the user ran
 * manually in a registered directory, so it must not be trusted for writes.
 */
export type HookSessionSource = 'payload' | 'conversation' | 'workspace';

export interface ResolvedHookSession {
  sessionId: string;
  source: HookSessionSource;
}

export function resolveSessionIdFromHookPayload(payload: Record<string, unknown>): ResolvedHookSession | undefined {
  const ftownId = payload.ftown_session_id;
  if (typeof ftownId === 'string' && ftownId) return { sessionId: ftownId, source: 'payload' };

  const data = loadRegistry();
  const conversationId = payload.conversation_id;
  if (typeof conversationId === 'string' && conversationId) {
    const byConv = data.byConversation[conversationId];
    if (byConv) return { sessionId: byConv, source: 'conversation' };
  }

  const roots = payload.workspace_roots;
  if (Array.isArray(roots) && typeof roots[0] === 'string' && roots[0]) {
    const byWs = data.byWorkspace[resolve(roots[0])];
    if (byWs) return { sessionId: byWs, source: 'workspace' };
  }

  return undefined;
}
