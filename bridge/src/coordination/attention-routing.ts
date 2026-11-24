import { existsSync } from 'node:fs';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { AttentionItem } from '../attention-events.js';
import { formatAttentionAnswerMail } from '../attention-prompt.js';
import { AttentionError } from '../attention-store.js';
import type { ArchivedSession, Session } from '../types.js';
import {
  PARENT_QUESTION_PREFIX,
  PARENT_UNAVAILABLE_NOTE,
  type AttentionRoute,
  type AttentionRoutingFields,
  type AttentionRoutingStoreApi,
} from './contract-b.js';

export function decideRoute(
  child: Session,
  parent: Session | null,
  parentRunning: boolean,
  to?: 'human',
): AttentionRoute {
  if (to === 'human') return 'human';
  if (!child.parentSessionId) return 'human';
  if (!parent) return 'human';
  if (parent.id !== child.parentSessionId || parent.id === child.id) return 'human';
  if (parent.status !== 'running') return 'human';
  if (parent.shellType === 'shell') return 'human';
  if (!parentRunning) return 'human';
  return 'parent';
}

export function formatParentQuestionMail(child: Session, item: AttentionItem): string {
  const header = `${PARENT_QUESTION_PREFIX} id=${item.id} from=${child.name} (${child.id})] ${item.title}\n${item.message}\n`;
  let middle = '';
  const questions = item.prompt?.questions ?? [];
  if (questions.length === 1) {
    const opts = questions[0].options;
    if (opts.length > 0) {
      middle = `Options: ${opts.map((opt, idx) => `${idx + 1}) ${opt.label}`).join(' ')}\n`;
    }
  } else if (questions.length > 1) {
    const lines: string[] = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      lines.push(`Q${i + 1}: ${q.question}`);
      if (q.options.length > 0) {
        lines.push(`Options: ${q.options.map((opt, idx) => `${idx + 1}) ${opt.label}`).join(' ')}`);
      }
    }
    middle = `${lines.join('\n')}\n`;
  }
  const footer =
    `Answer: ftown attention answer ${child.id} ${item.id} --option <n> | --text "<reply>"\n` +
    `Escalate to the human: ftown attention escalate ${child.id} ${item.id} --note "<context>"`;
  return header + middle + footer;
}

interface AttentionAnswerMessage {
  child: Session;
  item: AttentionItem;
  sender: { from: string; fromName: string };
  acceptMail?: (
    session: Session,
    body: Record<string, unknown>,
  ) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
}

export async function queueAttentionAnswer({ child, item, sender, acceptMail }: AttentionAnswerMessage): Promise<void> {
  try {
    if (!acceptMail || !item.prompt || !item.answer) throw new Error('Mail is not ready on this bridge');
    const accepted = await acceptMail(child, {
      from: sender.from,
      fromName: sender.fromName,
      type: 'message',
      threadId: `attention:${item.id}`,
      idempotencyKey: `attention-answer:${item.id}`,
      body: formatAttentionAnswerMail({
        attentionId: item.id,
        title: item.title || undefined,
        prompt: item.prompt,
        answers: item.answer.answers,
      }),
    });
    if (!accepted.ok) throw new Error(accepted.error);
  } catch (err) {
    console.error('[Bridge] Failed to mail attention answer:', err instanceof Error ? err.message : err);
    throw new AttentionError('attention_delivery_failed', 'Could not queue the answer for the session. Try again.', 503);
  }
}

export interface EscalateParentChildrenDeps {
  listSessions(): Promise<Session[]>;
  attention: {
    listRouted: AttentionRoutingStoreApi['listRouted'];
    setRoute(
      sessionId: string,
      eventId: string,
      fields: AttentionRoutingFields,
      expectRoute?: AttentionRoute,
    ): Promise<AttentionItem | undefined>;
  };
  now?: () => number;
  onEscalated?: (childId: string, item: AttentionItem) => void;
}

export async function escalateParentChildren(
  parentSessionId: string,
  deps: EscalateParentChildrenDeps,
): Promise<Array<{ sessionId: string; item: AttentionItem }>> {
  const sessions = await deps.listSessions();
  const children = sessions.filter(
    (s) => s.parentSessionId === parentSessionId && s.id !== parentSessionId,
  );
  if (children.length === 0) return [];
  const escalatedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const results: Array<{ sessionId: string; item: AttentionItem }> = [];
  for (const child of children) {
    const routed = await deps.attention.listRouted(child.id);
    for (const item of routed) {
      const updated = await deps.attention.setRoute(child.id, item.id, {
        route: 'human',
        escalatedAt,
        escalationNote: PARENT_UNAVAILABLE_NOTE,
      }, 'parent');
      if (updated && updated.route === 'human') {
        results.push({ sessionId: child.id, item: updated });
        try {
          deps.onEscalated?.(child.id, updated);
        } catch {
          // Observer errors must not abort remaining escalations.
        }
      }
    }
  }
  return results;
}

export interface EscalateOrphanedParentItemsDeps extends EscalateParentChildrenDeps {
  /** Extra liveness probe; when supplied, a stored 'running' parent must also pass it. */
  isParentRunning?: (parent: Session) => boolean;
}

/** A parent can still answer routed items only under the same checks decideRoute applies. */
function parentCanAnswer(parent: Session | undefined, deps: EscalateOrphanedParentItemsDeps): boolean {
  if (!parent) return false;
  if (parent.status !== 'running') return false;
  if (parent.shellType === 'shell') return false;
  if (deps.isParentRunning && !deps.isParentRunning(parent)) return false;
  return true;
}

/**
 * Start-up sweep: escalate every open parent-routed item whose parent cannot
 * answer it (missing, no longer running, or a shell). Parents that died while
 * the bridge was down never pass through the live exit path, so without this
 * pass their children wait on the parent indefinitely. Idempotent: escalation
 * is compare-and-set on route 'parent', so a second pass escalates nothing.
 */
export async function escalateOrphanedParentItems(
  deps: EscalateOrphanedParentItemsDeps,
): Promise<Array<{ sessionId: string; item: AttentionItem }>> {
  const sessions = await deps.listSessions();
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const deadParentIds: string[] = [];
  const checked = new Set<string>();
  for (const child of sessions) {
    const parentId = child.parentSessionId;
    if (!parentId || parentId === child.id || checked.has(parentId)) continue;
    checked.add(parentId);
    if (!parentCanAnswer(byId.get(parentId), deps)) deadParentIds.push(parentId);
  }
  const results: Array<{ sessionId: string; item: AttentionItem }> = [];
  for (const parentId of deadParentIds) {
    results.push(...await escalateParentChildren(parentId, deps));
  }
  return results;
}

export async function markArchivedWorktreeRetained(
  sessionDir: (sessionId: string) => string,
  sessionId: string,
  reason: string,
  now: () => number = Date.now,
): Promise<void> {
  const dataDir = dirname(dirname(sessionDir('probe')));
  const archivePath = join(dataDir, 'archive.jsonl');
  if (!existsSync(archivePath)) return;
  const raw = await readFile(archivePath, 'utf-8');
  const lines = raw.split('\n');
  let targetIndex = -1;
  const parsed: Array<{ raw: string; record?: ArchivedSession }> = lines.map((line, index) => {
    if (!line.trim()) return { raw: line };
    try {
      const record = JSON.parse(line) as ArchivedSession;
      if (record && typeof record.id === 'string' && record.id === sessionId && record.worktree) {
        targetIndex = index;
      }
      return { raw: line, record };
    } catch {
      return { raw: line };
    }
  });
  if (targetIndex < 0) return;
  const target = parsed[targetIndex].record!;
  target.worktree = {
    ...target.worktree!,
    retained: { reason, at: new Date(now()).toISOString() },
  };
  parsed[targetIndex].raw = JSON.stringify(target);
  const nextText = parsed.map((entry) => entry.raw).join('\n');
  const tmpPath = `${archivePath}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmpPath, 'w', 0o600);
    try {
      await handle.writeFile(nextText, 'utf-8');
    } finally {
      await handle.close();
    }
    await rename(tmpPath, archivePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
