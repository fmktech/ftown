import { projectBoardPage, type HomeProject, type ProjectBoard, type ProjectBoardStore } from './project-board-store.js';
import { BridgeSecurityError } from './security/bridge/errors.js';
import type { BridgeSecurityService } from './security/bridge/security.js';
import type { VerifiedPrincipal } from './security/protocol.js';

import type { ProjectStorageMoves } from './project-storage-move.js';
import type { ProjectBoardCommand } from './project-directory-protocol.js';

export interface BoardCommandDeps {
  bridgeId: string;
  security?: BridgeSecurityService;
  projectBoards?: ProjectBoardStore;
  storageMoves?: ProjectStorageMoves;
  rememberedProjects?: () => Promise<HomeProject[]>;
  discussionSession?: (bridgeId: string, sessionId: string) => Promise<{ name: string; projectName?: string } | null>;
  observeProject?: (projectId: string) => Promise<ProjectBoard>;
}

export async function runProjectBoardCommand(deps: BoardCommandDeps, command: ProjectBoardCommand,
  payload: Record<string, unknown>, principal?: VerifiedPrincipal): Promise<Record<string, unknown>> {
  const { bridgeId, security, projectBoards } = deps;
  if (!principal || !security || !projectBoards || payload.bridgeId !== bridgeId) throw new BridgeSecurityError('approval_required');
  const writing = command === 'mutate_project_board' || command === 'mutate_project_discussion';
  await security.policy.revalidate(principal, writing ? 'control' : 'read');
  if (command === 'list_projects') {
    const remembered = await deps.rememberedProjects?.() ?? [];
    await security.policy.revalidate(principal, 'read');
    const entries = [...projectBoards.list(), ...remembered];
    // Previously issued links may explicitly address an old home. Only a lookup
    // by stable ID follows its redirect, so deleted projects stay out of the directory.
    const redirect = typeof payload.projectId === 'string' ? projectBoards.movedHome(payload.projectId) : undefined;
    if (redirect && security.peerBridges().some(peer => peer.bridgeId === redirect.bridgeId)) entries.push(redirect);
    const revisions = new Map<string, number>();
    for (const entry of entries) revisions.set(entry.id, Math.max(entry.homeRevision ?? 0, revisions.get(entry.id) ?? 0));
    const projects = entries.filter(entry => (entry.homeRevision ?? 0) === revisions.get(entry.id));
    return { homeBridgeId: bridgeId, projects, ...(redirect && { movedProjectId: redirect.id }) };
  }
  if (typeof payload.projectId !== 'string') throw new Error('Missing project ID');
  if (command === 'mutate_project_board' && payload.action === 'move_project') {
    if (!deps.storageMoves || typeof payload.targetBridgeId !== 'string') throw new Error('Project storage moves unavailable');
    if (payload.waitForMove === true) return deps.storageMoves.waitForMove(payload.projectId, payload.targetBridgeId, payload.poll === true);
    return { project: await deps.storageMoves.move(payload.projectId, payload.targetBridgeId) };
  }
  if (command === 'get_project_discussion' || command === 'mutate_project_discussion') {
    const { bridgeId: _home, projectId, actorSessionId, ...operation } = payload;
    const endpoint = principal.endpoint;
    const peer = endpoint.kind === 'bridge' ? security.peerBridges().find(item => item.endpoint.id === endpoint.id) : undefined;
    if (endpoint.kind === 'bridge' && !peer) throw new BridgeSecurityError('permission_denied');
    let author: { name: string; bridgeId?: string; sessionId?: string } = peer
      ? { name: peer.label || peer.bridgeId, bridgeId: peer.bridgeId } : { name: 'User' };
    if (actorSessionId !== undefined) {
      if (endpoint.kind !== 'local-cli' && !peer) throw new BridgeSecurityError('permission_denied');
      if (typeof actorSessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(actorSessionId)) throw new Error('Invalid session ID');
      const origin = peer?.bridgeId ?? bridgeId;
      const session = await deps.discussionSession?.(origin, actorSessionId);
      if (!session || session.projectName !== projectBoards.projectName(projectId)) throw new Error('Session does not belong to this project');
      author = { name: session.name, bridgeId: origin, sessionId: actorSessionId };
      await security.policy.revalidate(principal, writing ? 'control' : 'read');
    }
    if (writing && Array.isArray(operation.mentions)) {
      const paired = new Set([bridgeId, ...security.peerBridges().map(item => item.bridgeId)]);
      if (operation.mentions.some(target => !paired.has(target?.bridgeId))) throw new Error('Mention a session on a paired bridge');
    }
    return projectBoards.discussion(projectId, operation, author, writing);
  }
  if (command === 'get_ticket_comments') {
    if (typeof payload.ticketId !== 'string' || (payload.after !== undefined && !Number.isSafeInteger(payload.after))) throw new Error('Invalid comment request');
    return projectBoards.comments(payload.projectId, payload.ticketId, payload.after as number | undefined);
  }
  const assignee = payload.assignee as { kind?: string; bridgeId?: string } | null | undefined;
  if (writing && assignee?.kind === 'bridge' && assignee.bridgeId !== bridgeId &&
      !security.peerBridges().some(peer => peer.bridgeId === assignee.bridgeId)) throw new Error('Choose a paired bridge');
  const endpoint = principal.endpoint;
  const author = endpoint.kind === 'bridge' ? security.peerBridges().find(peer => peer.endpoint.id === endpoint.id)?.label || endpoint.id : 'User';
  let board = writing ? projectBoards.mutate(payload, author) : projectBoards.read(payload.projectId);
  if (board.tickets.some(ticket => ticket.sessionIds.length) && payload.cursor === undefined && deps.observeProject) {
    board = await deps.observeProject(payload.projectId);
    await security.policy.revalidate(principal, 'read');
  }
  return { ...projectBoardPage(board, payload.cursor) };
}
