import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { PROJECT_DIRECTORY, projectDirectoryEntry } from './project-directory-protocol.js';
import type { ApplicationJson } from './security/protocol.js';
import type { PeerControl } from './peer-control.js';

// Store only the fields needed to draw the project tree.
const row = z.object({
  id: z.string(), bridgeId: z.string(), name: z.string(), projectName: z.string().optional(),
  parentBridgeId: z.string().optional(), parentSessionId: z.string().optional(),
  status: z.enum(['pending', 'running', 'completed', 'error', 'disconnected']),
  createdAt: z.string(), updatedAt: z.string(), boardBlocked: z.boolean().optional(),
});
const snapshot = z.object({ sessions: z.array(row) });
export function parsePeerSessions(body: unknown, owner: string) {
  const rows = snapshot.parse(body).sessions;
  if (rows.some(session => session.bridgeId !== owner)) throw new Error('Invalid session owner');
  return rows;
}
export function startPeerSessionCache(peers: Pick<PeerControl, 'list' | 'http'>, path: string) {
  return startPeerCache(peers, path, 'sessions', row, id => peers.http(id, 'GET', '/api/sessions?boardAttention=1'), parsePeerSessions);
}

export function startPeerProjectDirectory(peers: Pick<PeerControl, 'list' | 'directHttp' | 'connectDirect'>, path: string) {
  return startPeerCache(peers, path, 'projects', projectDirectoryEntry, async id => {
    if (!await peers.connectDirect(id)) throw new Error('Peer is offline');
    return peers.directHttp(id, PROJECT_DIRECTORY, {});
  }, (body, owner) => {
    const { projects } = z.object({ projects: z.array(projectDirectoryEntry) }).parse(body);
    if (projects.some(project => project.bridgeId !== owner)) throw new Error('Invalid project owner');
    return projects;
  });
}

async function startPeerCache<T>(peers: Pick<PeerControl, 'list'>, path: string, kind: 'sessions' | 'projects',
  rowSchema: z.ZodType<T>, fetch: (owner: string) => Promise<{ status: number; body: ApplicationJson }>,
  parse: (body: unknown, owner: string) => T[]) {
  const endpointFilename = new RegExp('^peer-' + kind + '-[A-Za-z0-9_-]{43}\\.json$');
  if (endpointFilename.test(basename(path))) {
    for (const name of await readdir(dirname(path))) {
      if (name !== basename(path) && endpointFilename.test(name)) await unlink(join(dirname(path), name));
    }
  }
  let saved: Record<string, T[]> = {};
  try { saved = z.record(z.string(), z.array(rowSchema)).parse(JSON.parse(await readFile(path, 'utf8'))); } catch {}
  let active: Promise<void> | undefined;
  async function refresh() {
    const approved = await peers.list();
    const next = { ...saved };
    for (const key of Object.keys(next)) {
      if (!approved.some(peer => peer.endpointId === key)) delete next[key];
    }
    await Promise.all(approved.map(async peer => {
      try {
        const result = await fetch(peer.bridgeId);
        if (result.status === 401 || result.status === 403) { delete next[peer.endpointId]; return; }
        if (result.status !== 200) return;
        try { next[peer.endpointId] = parse(result.body, peer.bridgeId); }
        catch { delete next[peer.endpointId]; }
      } catch { /* Keep the last complete snapshot until the peer responds. */ }
    }));
    if (JSON.stringify(next) === JSON.stringify(saved)) return;
    await writeFile(path + '.tmp', JSON.stringify(next), { mode: 0o600 });
    await rename(path + '.tmp', path);
    saved = next;
  }
  const tick = () => {
    active ??= refresh().catch(() => console.error('Could not persist peer ' + kind)).finally(() => { active = undefined; });
    return active;
  };
  tick();
  const timer = setInterval(tick, 30_000);
  timer.unref();
  return {
    list: async () => (await peers.list()).flatMap(peer => saved[peer.endpointId] ?? []),
    refresh: tick,
    stop: () => { clearInterval(timer); return active; },
  };
}
