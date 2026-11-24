import type { ProjectBoardStore } from './project-board-store.js';
import type { PeerControl } from './peer-control.js';
import type { Session } from './types.js';

type Sessions = (id: string) => Promise<Session | null | undefined>;
type Accept = (session: Session, body: Record<string, unknown>) => Promise<{ ok: boolean }>;

/** Read the author's session at its hosting bridge, including freshly launched workers not yet in the peer cache. */
export async function discussionSession(localId: string, load: Sessions, peers: PeerControl, origin: string, id: string) {
  if (origin === localId) {
    const session = await load(id);
    return session && session.bridgeId === origin ? session : null;
  }
  const reply = await peers.http(origin, 'GET', '/api/sessions/' + encodeURIComponent(id));
  if (reply.status !== 200) return null;
  const session = (reply.body as { session?: Partial<Session> } | null)?.session;
  return session?.id === id && session.bridgeId === origin && typeof session.name === 'string'
    ? { name: session.name, projectName: session.projectName } : null;
}

export async function deliverDiscussionMail(projects: ProjectBoardStore, projectId: string, localId: string, peers: PeerControl,
  load: Sessions, accept: Accept): Promise<void> {
  let allowed: Set<string> | undefined;
  let after = 0;
  const deferred = new Set<string>();
  for (;;) {
    const page = projects.pendingDiscussionMail(projectId, after, 50);
    if (!page.length) return;
    const projectName = projects.projectName(projectId);
    after = page[page.length - 1].seq;
    const batches = new Map<string, typeof page>();
    for (const notice of page) {
      const batch = batches.get(notice.bridgeId);
      if (batch) batch.push(notice);
      else batches.set(notice.bridgeId, [notice]);
    }
    if (!allowed && [...batches.keys()].some(id => id !== localId)) allowed = new Set((await peers.list()).map(peer => peer.bridgeId));
    await Promise.all([...batches].map(async ([target, batch]) => {
      if (deferred.has(target) || (target !== localId && !allowed?.has(target))) return;
      try {
        for (const notice of batch) {
          const discussion = target === localId ? { projectId } : { projectId, homeBridgeId: localId };
          const replyCommand = `ftown discuss reply ${notice.threadId} --project ${projectId}` +
            (target === localId ? '' : ` --bridge ${localId}`) + ' --text "your reply"';
          const body = { body: notice.body + '\n\nReply in this discussion thread: ' + replyCommand, discussion,
            type: 'message', from: 'project-discussion', fromName: projectName + ' discussion',
            threadId: notice.threadId, discussionProject: projectName, idempotencyKey: 'discussion:' + projectId + ':' + notice.id };
          if (target === localId) {
            const recipient = await load(notice.sessionId);
            if (recipient?.projectName === projectName && !(await accept(recipient, body)).ok) { deferred.add(target); return; }
          } else {
            const reply = await peers.http(target, 'POST', '/api/sessions/' + encodeURIComponent(notice.sessionId) + '/inbox', body);
            // Removed sessions and recipients moved out of the project no longer need this notice.
            if (![201, 404, 409].includes(reply.status)) { deferred.add(target); return; }
          }
          projects.acknowledgeDiscussionMail(projectId, notice.id);
        }
      } catch { deferred.add(target); }
    }));
  }
}
