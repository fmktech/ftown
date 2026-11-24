import { readRevision, saveInstructions } from './instructions.js';
import { exec } from 'node:child_process';
import { runProjectBoardCommand, type BoardCommandDeps } from './project-board-commands.js';
import { ProjectBoardChanged } from './project-board-store.js';
import type { VerifiedApplication } from './security/protocol.js';
import { BridgeSecurityError } from './security/bridge/errors.js';
import { ledgerChainPage, ledgerHeadAnswer, parseLedgerChainQuery, parseLedgerHeadQuery, type HeldLedger } from './security/bridge/ledger-rpc.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { listNativeSessions } from './native-session-list.js';
import { loadAccounts } from './accounts.js';
import { claudeConfigDir } from './config-dirs.js';
import type { NativeSessionHarness, NativeSessionSummary } from './native-session-list.js';

import { prReviewGeneration, toDashboardWireSession } from './session-wire.js';
import { normalizePullRequestUrl } from './pull-request-url.js';
import type { PullRequestStatusService } from './pull-request-status.js';
import type { PrReviewService, PrReviewRequest, PrReviewChunkRequest } from './pull-request-review-protocol.js';
import { PR_REVIEW_CHUNK_BYTES } from './pull-request-review-protocol.js';
import { InvalidShellTypeError, normalizeShellType, type ShellType } from './harness-registry.js';
import { AccountSelectionError, PlanItemError, WorkingDirMissingError } from './create-ftown-session.js';
import { WorktreeError } from './coordination/contract-b.js';
import { buildSessionBoardSnapshot, type SessionBoardSource } from './session-board-snapshot.js';
import { createSessionBoardCache, SessionBoardRequestError } from './session-board-cache.js';
import { SESSION_BOARD_CHUNK_BYTES } from './session-board-protocol.js';
export type { SessionBoardSource } from './session-board-snapshot.js';
import type { AttentionItem } from './attention-events.js';
import { AUTOMATION_REMOVED_CODE, AUTOMATION_REMOVED_MESSAGE, AutomationRemovedError, RETIRED_AUTOMATION_COMMANDS } from './retired-automation.js';
import type { SessionController } from './session-controller.js';
import type { Session } from './types.js';
import type { SessionMessageAccepted, SessionMessageErrorCode } from './session-inbox-protocol.js';
import { AttentionError, type AttentionStore } from './attention-store.js';
import { ATTENTION_SUMMARY_MAX_BYTES, ATTENTION_SUMMARY_TOO_LARGE } from './attention-summary-protocol.js';
import { queueAttentionAnswer } from './coordination/attention-routing.js';
import { BridgeUpdateError, type BridgeUpdateCoordinator } from './bridge-update.js';
import type { UpdateEffects } from './update-effects.js';
import { validFileId, validPreviewId, validRevision } from './session-preview.js';
import { PREVIEW_CHUNK_BYTES, PREVIEW_MAX_WAIT_MS } from './preview-protocol.js';
import type { DirectAddress } from './direct-transport/contract.js';
import type { ModelRoutingService } from './quota/routing-service.js';
import type { ModelRoutingConfig } from './quota/types.js';

import type {
  BridgeExecPayload,
  ClearTerminalPayload,
  Command,
  CommandResponse,
  CreateSessionPayload,
  GetHistoryPayload,
  HandoffSessionPayload,
  GetSessionUsagePayload,
  GetSessionsUsagePayload,
  RemoveSessionPayload,
  RenameSessionPayload,
  UpdateSessionParentPayload,
  StopSessionPayload,
} from './types.js';

const execAsync = promisify(exec);
/** Largest serialized set_model_routing payload accepted before validation. */
const MODEL_ROUTING_MAX_PAYLOAD_BYTES = 256 * 1024;

function auditBridgeExec(payload: BridgeExecPayload): void {
  try {
    const dir = join(homedir(), '.ftown', 'logs');
    mkdirSync(dir, { recursive: true });
    const entry = `${JSON.stringify({ at: new Date().toISOString(), operation: 'bridge_exec' })}\n`;
    appendFileSync(join(dir, 'exec-audit.log'), entry, { mode: 0o600 });
  } catch {
    // Auditing is best-effort and must never block execution.
  }
}

interface ExecError {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CommandRpcDeps extends BoardCommandDeps {
  hostResources?: ReturnType<typeof import('./host-resources.js').hostResourceSampler>;
  sessionController: SessionController;
  pullRequestStatuses?: PullRequestStatusService;
  pullRequestReview?: PrReviewService;
  enqueueSessionMessage?: (session: Session, message: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  attentionStore?: AttentionStore;
  /** Ask every tab to re-read the attention snapshot after a command resolves it. */
  publishAttentionChanged?: (sessionId: string) => void;
  /** Durable mail path with full mail fields (threadId etc.); used for the answer_session_attention mail fallback. */
  acceptSessionMail?: (session: Session, body: Record<string, unknown>) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  updates?: BridgeUpdateCoordinator;
  /** Where browsers can reach this bridge without signaling; null while the fixed-address listener is off. */
  directAddress?: () => DirectAddress | null;
  updateEffects?: UpdateEffects;
  /** The bridge's long-lived model-routing service (get_model_routing / set_model_routing); resolved only when one of those commands runs. */
  modelRouting?: () => ModelRoutingService;
  /** Native harness session listing; injectable for command boundary tests. */
  listNativeSessions?: (harness: NativeSessionHarness, workingDir: string, home?: string, claudeConfigDir?: string) => Promise<NativeSessionSummary[]>;
  /** Read-only board snapshot for `get_session_board`. Absent → unavailable. */
  sessionBoard?: SessionBoardSource;
  /** One-step replacement of a session in its current directory. */
  handoffSession?: (sessionId: string, request: { shellType?: ShellType; model?: string; name?: string }) => Promise<{ session: Session }>;
  publishCommandResponse: (response: CommandResponse, verified?: VerifiedApplication) => Promise<void>;
}

const PLAN_ITEM_ID = /^p\d{1,6}$/;
// index creates an adapter per command. Scope cache lifetime to the stable,
// read-only board source, never to a transient handler or a global account key.
const boardCaches = new WeakMap<SessionBoardSource, ReturnType<typeof createSessionBoardCache>>();

function planItemFromPayload(payload: { planItem?: unknown }): string | undefined {
  return typeof payload.planItem === 'string' && PLAN_ITEM_ID.test(payload.planItem) ? payload.planItem : undefined;
}

async function revalidateAttentionRead(deps: CommandRpcDeps, verified: VerifiedApplication | undefined): Promise<void> {
  if (deps.security && verified) await deps.security.policy.revalidate(verified.principal, 'read');
}

async function handleGetSessionBoard(
  deps: CommandRpcDeps,
  command: Command,
  verified: VerifiedApplication | undefined,
): Promise<CommandResponse> {
  const payload = command.payload as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || payload.bridgeId !== deps.bridgeId
    || typeof payload.sessionId !== 'string'
    || !/^[A-Za-z0-9_-]{1,200}$/.test(payload.sessionId)
    || Object.keys(payload).some((key) => !['bridgeId', 'sessionId', 'snapshotId', 'offset'].includes(key))
    || (Object.hasOwn(payload, 'snapshotId') !== Object.hasOwn(payload, 'offset'))
    || (Object.hasOwn(payload, 'snapshotId') && (typeof payload.snapshotId !== 'string' || !/^[a-f0-9]{64}$/.test(payload.snapshotId)
      || typeof payload.offset !== 'number' || !Number.isSafeInteger(payload.offset) || payload.offset < 0 || payload.offset % SESSION_BOARD_CHUNK_BYTES !== 0))) {
    throw new SessionBoardRequestError('invalid_session_board_request', 400);
  }
  if (deps.security && verified) {
    await deps.security.policy.revalidate(verified.principal, 'read');
  }
  const source = deps.sessionBoard;
  if (!source) {
    return {
      requestId: command.requestId,
      success: false,
      error: 'Board is not available on this bridge',
      data: { code: 'unavailable' },
    };
  }
  const session = await deps.sessionController.get(payload.sessionId);
  if (!session || session.bridgeId !== deps.bridgeId) throw new SessionBoardRequestError('session_board_snapshot_unavailable', 404);
  let cache = boardCaches.get(source);
  if (!cache) { cache = createSessionBoardCache(); boardCaches.set(source, cache); }
  const scope = JSON.stringify([deps.bridgeId, payload.sessionId, verified?.principal.endpoint.id ?? 'local', verified?.principal.policyGeneration ?? null]);
  if (typeof payload.snapshotId === 'string') {
    return { requestId: command.requestId, success: true, data: cache.chunk(scope, payload.snapshotId, payload.offset as number) };
  }
  const snapshot = await buildSessionBoardSnapshot(source, payload.sessionId);
  if (deps.security && verified) await deps.security.policy.revalidate(verified.principal, 'read');
  const current = await deps.sessionController.get(payload.sessionId);
  if (!current || current.bridgeId !== deps.bridgeId) throw new SessionBoardRequestError('session_board_snapshot_unavailable', 404);
  return { requestId: command.requestId, success: true, data: cache.store(scope, snapshot) };
}

/**
 * Centrifugo commands:rpc adapter: a thin wire-marshaling switch around the
 * transport-agnostic session controller. Commands addressed to another
 * bridge (payload.bridgeId mismatch) are ignored without a response, except
 * for answer_session_attention: an answer request always gets one typed
 * answer, because a silent drop leaves the dashboard waiting out its RPC
 * deadline and reporting a transport timeout instead of a reason.
 */
export function createCommandHandler(deps: CommandRpcDeps): (command: Command, verified?: VerifiedApplication) => Promise<void> {
  const { bridgeId, sessionController } = deps;

  return async function handleCommand(command: Command, verified?: VerifiedApplication): Promise<void> {
    console.log(`[Bridge] Received command: ${command.type} (requestId: ${command.requestId})`);

    const payloadBridgeId = command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
      ? (command.payload as Record<string, unknown>).bridgeId as string | undefined : undefined;
    if (payloadBridgeId && payloadBridgeId !== bridgeId) {
      if (command.type === 'answer_session_attention') {
        try {
          await deps.publishCommandResponse({ requestId: command.requestId, success: false,
            error: 'This attention item belongs to another computer.', data: { code: 'wrong_bridge' } }, verified);
        } catch (err) {
          console.error('[Bridge] Failed to publish the wrong-bridge answer:', err instanceof Error ? err.message : err);
        }
      }
      return;
    }

    let response: CommandResponse;

    try {
      if (RETIRED_AUTOMATION_COMMANDS.has(command.type)) throw new AutomationRemovedError();
      if (deps.security && !verified) throw new Error('approval_required');
      if (deps.security && verified) await deps.security.revalidate(verified.principal);
      switch (command.type) {
        case 'get_session_board': {
          response = await handleGetSessionBoard(deps, command, verified);
          break;
        }
        case 'preview_chat_list':
        case 'preview_chat_send':
        case 'preview_chat_reply': {
          const payload: Record<string, unknown> = { ...command.payload };
          const allowed = command.type === 'preview_chat_list' ? ['bridgeId', 'sessionId', 'cursor'] : ['bridgeId', 'sessionId', 'id', 'text'];
          if (Object.keys(payload).some(key => !allowed.includes(key)) || payload.bridgeId !== bridgeId || typeof payload.sessionId !== 'string'
            || !/^[A-Za-z0-9_-]{1,200}$/.test(payload.sessionId)
            || (command.type === 'preview_chat_list' ? payload.cursor !== undefined && typeof payload.cursor !== 'string' : typeof payload.id !== 'string' || typeof payload.text !== 'string')) {
            response = { requestId: command.requestId, success: false, error: 'Invalid conversation request', data: { code: 'invalid' } }; break;
          }
          const result = command.type === 'preview_chat_list'
            ? await sessionController.listPreviewChat(payload.sessionId, typeof payload.cursor === 'string' ? payload.cursor : undefined)
            : command.type === 'preview_chat_send'
              ? await sessionController.sendPreviewChat(payload.sessionId, { id: String(payload.id), text: String(payload.text) })
              : await sessionController.replyPreviewChat(payload.sessionId, { id: String(payload.id), text: String(payload.text) });
          response = result.ok ? { requestId: command.requestId, success: true, data: 'page' in result ? result.page : result.result }
            : { requestId: command.requestId, success: false, error: result.message, data: { code: result.code } };
          break;
        }
        case 'send_message': {
          if (!deps.security || !verified) throw new BridgeSecurityError('approval_required');
          await deps.security.policy.revalidate(verified.principal, 'control');
          const payload = command.payload as Record<string, unknown>;
          const failure = (code: SessionMessageErrorCode, error: string): CommandResponse =>
            ({ requestId: command.requestId, success: false, error, data: { code } });
          const keys = payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload).sort().join(',') : '';
          if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (keys !== 'bridgeId,eventId,message,sessionId' && keys !== 'bridgeId,message,sessionId')
            || payload.bridgeId !== bridgeId || typeof payload.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(payload.sessionId)
            || typeof payload.message !== 'string' || !payload.message.trim() || payload.message.length > 65_536
            || (payload.eventId !== undefined && (typeof payload.eventId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(payload.eventId)))) {
            response = failure('invalid_request', 'Invalid reply request.'); break;
          }
          let session: Session | null;
          try { session = await sessionController.get(payload.sessionId); } catch { session = null; }
          if (!session || session.bridgeId !== bridgeId || session.status !== 'running') {
            response = failure('session_unavailable', 'The session is unavailable or not running.'); break;
          }
          if (!deps.enqueueSessionMessage) { response = failure('mail_not_ready', 'Mail is not ready on this bridge.'); break; }
          try {
            const result = await deps.enqueueSessionMessage(session, payload.message);
            if (result.ok && typeof result.id === 'string' && result.id.length > 0) {
              if (typeof payload.eventId === 'string' && deps.attentionStore) {
                try {
                  await deps.attentionStore.resolveReplied(payload.sessionId, payload.eventId);
                  try { deps.publishAttentionChanged?.(payload.sessionId); } catch (err) { console.warn('[Bridge] Could not publish replied attention:', err instanceof Error ? err.message : err); }
                } catch (err) { console.warn('[Bridge] Could not resolve replied attention:', err instanceof Error ? err.message : err); }
              }
              response = { requestId: command.requestId, success: true, data: { sessionId: session.id, messageId: result.id, status: 'queued' } satisfies SessionMessageAccepted };
            } else {
              response = !result.ok && result.error === 'Mail store not ready'
                ? failure('mail_not_ready', 'Mail is not ready on this bridge.')
                : failure('enqueue_failed', 'Reply may have been queued; check before sending again.');
            }
          } catch {
            response = failure('enqueue_failed', 'Reply may have been queued; check before sending again.');
          }
          break;
        }

        case 'get_pull_request_review':
        case 'get_pull_request_review_chunk': {
          if (!deps.security || !verified || !deps.pullRequestReview || verified.principal.endpoint.kind !== 'browser') throw new BridgeSecurityError('permission_denied');
          await deps.security.policy.revalidate(verified.principal, 'read');
          const payload = command.payload as Record<string, unknown>;
          const chunk = command.type === 'get_pull_request_review_chunk';
          const expected = chunk ? 'bridgeId,linkGeneration,offset,revision,sessionId' : 'bridgeId,linkGeneration,sessionId';
          if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).sort().join(',') !== expected
            || payload.bridgeId !== bridgeId || typeof payload.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(payload.sessionId)
            || typeof payload.linkGeneration !== 'string' || !/^[a-f0-9]{64}$/.test(payload.linkGeneration)
            || (chunk && (typeof payload.revision !== 'string' || !/^[a-f0-9]{64}$/.test(payload.revision)
              || typeof payload.offset !== 'number' || !Number.isSafeInteger(payload.offset) || payload.offset < 0 || payload.offset % PR_REVIEW_CHUNK_BYTES !== 0))) {
            response = { requestId: command.requestId, success: false, error: 'Invalid review request', data: { code: 'invalid' } }; break;
          }
          const result = chunk ? await deps.pullRequestReview.chunk(verified.principal, payload as unknown as PrReviewChunkRequest)
            : await deps.pullRequestReview.get(verified.principal, payload as unknown as PrReviewRequest);
          await deps.security.policy.revalidate(verified.principal, 'read');
          const current = await sessionController.get(payload.sessionId as string).catch(() => null);
          await deps.security.policy.revalidate(verified.principal, 'read');
          const validLink = current?.bridgeId === bridgeId && !!current.pullRequestUrl && !!current.pullRequestLinkId
            && prReviewGeneration(current.pullRequestLinkId) === payload.linkGeneration;
          response = { requestId: command.requestId, success: true, data: validLink || (result.state !== 'ready' && result.state !== 'chunk') ? result : { state: 'unavailable', reason: 'stale' } };
          break;
        }

        case 'get_pull_request_statuses': {
          if (!deps.security || !verified || payloadBridgeId !== bridgeId || !deps.pullRequestStatuses) throw new Error('approval_required');
          const payload = command.payload as Record<string, unknown>;
          const ids = payload.sessionIds;
          if (Object.keys(payload).sort().join(',') !== 'bridgeId,sessionIds' || !Array.isArray(ids) || ids.length < 1 || ids.length > 100
            || ids.some(id => typeof id !== 'string' || id.length > 200 || !/^[A-Za-z0-9_-]+$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('Invalid status request');
          const urls: string[] = [];
          for (const id of ids as string[]) {
            const session = await sessionController.get(id);
            if (session?.bridgeId !== bridgeId || !session.pullRequestUrl) continue;
            try { urls.push(normalizePullRequestUrl(session.pullRequestUrl)); } catch { /* Ignore invalid persisted URLs. */ }
          }
          const result = await deps.pullRequestStatuses.get(urls);
          response = { requestId: command.requestId, success: true, data: { bridgeId, ...result } };
          break;
        }

        case 'session_preview_status':
        case 'session_preview_chunk': {
          const payload = command.payload;
          const keys = Object.keys(payload);
          const common = ['bridgeId', 'sessionId', 'previewId', 'fileId'];
          const allowed = command.type === 'session_preview_status' ? [...common, 'knownRevision', 'waitMs'] : [...common, 'revision', 'offset'];
          if (keys.some(key => !allowed.includes(key)) || !('bridgeId' in payload) || payload.bridgeId !== bridgeId
            || !('sessionId' in payload) || typeof payload.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(payload.sessionId)
            || !('previewId' in payload) || !validPreviewId(payload.previewId)
            || !('fileId' in payload) || !validFileId(payload.fileId)
            || (command.type === 'session_preview_status' && 'knownRevision' in payload && !validRevision(payload.knownRevision))
            // Waiting only makes sense against a revision the caller already holds.
            || (command.type === 'session_preview_status' && 'waitMs' in payload && (!('knownRevision' in payload) || typeof payload.waitMs !== 'number'
              || !Number.isInteger(payload.waitMs) || payload.waitMs < 1 || payload.waitMs > PREVIEW_MAX_WAIT_MS))
            || (command.type === 'session_preview_chunk' && (!('revision' in payload) || !validRevision(payload.revision)
              || !('offset' in payload) || typeof payload.offset !== 'number' || !Number.isSafeInteger(payload.offset)
              || payload.offset < 0 || payload.offset % PREVIEW_CHUNK_BYTES !== 0))) {
            response = { requestId: command.requestId, success: false, error: 'Invalid preview request', data: { code: 'invalid' } };
            break;
          }
          const result = command.type === 'session_preview_status'
            ? await sessionController.getPreviewStatus(payload.sessionId, payload.previewId, payload.fileId, 'knownRevision' in payload && typeof payload.knownRevision === 'string' ? payload.knownRevision : undefined,
              'waitMs' in payload && typeof payload.waitMs === 'number' ? payload.waitMs : 0)
            : await sessionController.getPreviewChunk(payload.sessionId, payload.previewId, payload.fileId, 'revision' in payload && typeof payload.revision === 'string' ? payload.revision : '', 'offset' in payload && typeof payload.offset === 'number' ? payload.offset : -1);
          response = result.ok ? { requestId: command.requestId, success: true, data: result.preview }
            : { requestId: command.requestId, success: false, error: result.message, data: { code: result.code } };
          break;
        }
        case 'get_project_discussion':
        case 'mutate_project_discussion':
        case 'list_projects':
        case 'get_project_board':
        case 'get_ticket_comments':
        case 'mutate_project_board': {
          const data = await runProjectBoardCommand(deps, command.type, command.payload as Record<string, unknown>, verified?.principal);
          response = { requestId: command.requestId, success: true, data };
          break;
        }
        case 'get_instructions':
        case 'set_instructions': {
          if (!verified || !deps.security || payloadBridgeId !== bridgeId) throw new BridgeSecurityError('approval_required');
          const writing = command.type === 'set_instructions';
          await deps.security.policy.revalidate(verified.principal, writing ? 'control' : 'read');
          const { scope, text } = command.payload as Record<string, unknown>;
          if (scope !== 'bridge' && scope !== 'global') throw new Error('Invalid instruction scope');
          if (writing && typeof text !== 'string') throw new Error('Expected Markdown text');
          const data = writing ? saveInstructions(scope, text as string) : readRevision(scope);
          response = { requestId: command.requestId, success: true, data };
          break;
        }
        case 'get_direct_address': {
          const payload = command.payload as Record<string, unknown>;
          if (!verified || payloadBridgeId !== bridgeId || Object.keys(payload).some(key => key !== 'bridgeId')) throw new Error('approval_required');
          const address = deps.directAddress?.() ?? null;
          response = { requestId: command.requestId, success: true, data: { bridgeId, address } };
          break;
        }
        case 'get_bridge_update':
        case 'update_bridge': {
          if (!verified || !deps.security || !deps.updates || !deps.updateEffects || payloadBridgeId !== bridgeId) throw new BridgeUpdateError('invalid_update_request', 'Update request unavailable');
          const payload = command.payload as Record<string, unknown>;
          if (command.type === 'get_bridge_update') {
            if (Object.keys(payload).some(key => key !== 'bridgeId' && key !== 'refresh') || (payload.refresh !== undefined && typeof payload.refresh !== 'boolean')) throw new BridgeUpdateError('invalid_update_request', 'Invalid update request');
            const status = await deps.updates.snapshot(verified.principal, payload.refresh === true);
            response = { requestId: command.requestId, success: true, data: status as unknown as Record<string, unknown> };
          } else {
            if (Object.keys(payload).sort().join(',') !== 'bridgeId,operationId,targetVersion' || typeof payload.targetVersion !== 'string' || typeof payload.operationId !== 'string') throw new BridgeUpdateError('invalid_update_request', 'Invalid update request');
            const result = await deps.updates.request(verified.principal, payload.targetVersion, payload.operationId);
            if (result.ticket) deps.updateEffects.attachTicket(verified, result.ticket);
            response = { requestId: command.requestId, success: true, data: result.accepted as unknown as Record<string, unknown> };
          }
          break;
        }
        case 'get_accounts': {
          if (!deps.security || !verified) throw new BridgeSecurityError('approval_required');
          await deps.security.policy.revalidate(verified.principal, 'read');
          const payload = command.payload as Record<string, unknown> | null;
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)
            || payload.bridgeId !== bridgeId || Object.keys(payload).some(key => key !== 'bridgeId')) {
            response = { requestId: command.requestId, success: false, error: 'Invalid accounts request', data: { code: 'invalid' } };
            break;
          }
          let registered;
          try { registered = loadAccounts().accounts; }
          catch { throw new Error('Could not read accounts on this bridge'); }
          const accounts = [
            { id: 'default', harness: 'claude', isDefault: true },
            { id: 'default', harness: 'codex', isDefault: true },
            ...registered.map(({ id, harness, label }) => ({
              id, harness, ...(label === undefined ? {} : { label }), isDefault: false,
            })),
          ];
          response = { requestId: command.requestId, success: true, data: { accounts } };
          break;
        }
        case 'get_model_routing':
        case 'set_model_routing': {
          if (deps.security && verified) await deps.security.policy.revalidate(verified.principal, command.type === 'get_model_routing' ? 'read' : 'control');
          const payload = command.payload as Record<string, unknown>;
          const invalid = (): CommandResponse => ({ requestId: command.requestId, success: false, error: 'Invalid model routing request', data: { code: 'invalid' } });
          if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.bridgeId !== bridgeId) { response = invalid(); break; }
          const modelRouting = deps.modelRouting?.();
          if (!modelRouting) { response = { requestId: command.requestId, success: false, error: 'Model routing is not available on this bridge', data: { code: 'unavailable' } }; break; }
          if (command.type === 'get_model_routing') {
            if (Object.keys(payload).some(key => key !== 'bridgeId' && key !== 'refresh') || (payload.refresh !== undefined && typeof payload.refresh !== 'boolean')) { response = invalid(); break; }
            const snapshot = await modelRouting.get(payload.refresh === undefined ? {} : { refresh: payload.refresh });
            response = { requestId: command.requestId, success: true, data: snapshot };
          } else {
            if (Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8') > MODEL_ROUTING_MAX_PAYLOAD_BYTES) {
              response = { requestId: command.requestId, success: false, error: 'routing config is too large', data: { code: 'too_large' } }; break;
            }
            if (Object.keys(payload).some(key => key !== 'bridgeId' && key !== 'config' && key !== 'overwriteInvalid') || payload.config === undefined) { response = invalid(); break; }
            // Only a strict boolean true confirms replacing an invalid file; any other value counts as absent.
            const config = payload.config as ModelRoutingConfig;
            const result = await modelRouting.set(payload.overwriteInvalid === true ? { config, overwriteInvalid: true } : { config });
            response = { requestId: command.requestId, success: true, data: result };
          }
          break;
        }
        case 'security_devices':
        case 'security_invite':
        case 'security_revoke': {
          // Account membership changes only through the passkey ledger: in account mode the policy refuses invitations and the
          // removal of ledger devices with account_managed.
          if (!deps.security || !verified || payloadBridgeId !== bridgeId) throw new Error('approval_required');
          const payload = command.payload as Record<string, unknown>;
          let result: unknown;
          if (command.type === 'security_devices') result = { devices: await deps.security.listDevices(verified.principal) };
          else if (command.type === 'security_invite') result = await deps.security.createInvitation(verified.principal, { label: typeof payload.label === 'string' ? payload.label : '' });
          else {
            if (typeof payload.endpointId !== 'string') throw new Error('invalid_envelope');
            await deps.security.revokeEndpoint(verified.principal, payload.endpointId); result = { endpointId: payload.endpointId, revoked: true };
          }
          response = { requestId: command.requestId, success: true, data: result as Record<string, unknown> };
          break;
        }
        case 'ledger_head':
        case 'ledger_chain': {
          // Read-only, account mode: only a browser of this bridge's trusted checkpoint may read its chain (memberLedger refuses anyone
          // else, before the arguments are looked at). No side effects.
          if (!deps.security || !verified || payloadBridgeId !== bridgeId) throw new BridgeSecurityError('permission_denied');
          // ledger_head answers the tip without touching the chain; ledger_chain copies only the records of its page.
          const held = command.type === 'ledger_head' ? await deps.security.memberHead(verified.principal) : await deps.security.memberLedger(verified.principal);
          const query = command.type === 'ledger_head' ? parseLedgerHeadQuery(command.payload, bridgeId) : parseLedgerChainQuery(command.payload, bridgeId);
          if (query === false || query === null) {
            response = { requestId: command.requestId, success: false, error: 'Invalid ledger request', data: { code: 'invalid' } };
            break;
          }
          const data = query === true ? ledgerHeadAnswer(held) : ledgerChainPage(held as HeldLedger, query);
          response = { requestId: command.requestId, success: true, data };
          break;
        }
        case 'get_session_attention':
        case 'resolve_session_attention': {
          const payload = command.payload as Record<string, unknown>;
          const allowed = command.type === 'resolve_session_attention' ? ['bridgeId', 'sessionId', 'eventId'] : ['bridgeId', 'sessionId'];
          if (payload.bridgeId !== bridgeId || typeof payload.sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(payload.sessionId)
            || Object.keys(payload).some(key => !allowed.includes(key))) throw new AttentionError('invalid_attention_request', 'Invalid attention target', 400);
          if (command.type === 'resolve_session_attention' && (typeof payload.eventId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(payload.eventId))) throw new AttentionError('invalid_attention_request', 'Invalid attention eventId', 400);
          const session = await sessionController.get(payload.sessionId);
          if (!session || session.bridgeId !== bridgeId) throw new AttentionError('session_unavailable', 'This session is no longer available', 404);
          if (!deps.attentionStore) throw new AttentionError('attention_not_ready', 'Attention store is not ready', 503);
          const snapshot = command.type === 'get_session_attention'
            ? await deps.attentionStore.explicitSnapshot(payload.sessionId)
            : await deps.attentionStore.resolveExplicitThrough(payload.sessionId, payload.eventId as string);
          if (command.type === 'resolve_session_attention') {
            try { deps.publishAttentionChanged?.(payload.sessionId); } catch (err) { console.warn('[Bridge] Could not publish dismissed attention:', err instanceof Error ? err.message : err); }
          }
          response = { requestId: command.requestId, success: true, data: { sessionId: payload.sessionId, ...snapshot } };
          break;
        }
        case 'get_attention_summary': {
          const payload = command.payload as Record<string, unknown>;
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)
            || payload.bridgeId !== bridgeId || !Array.isArray(payload.sessionIds) || payload.sessionIds.length > 500
            || payload.sessionIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)
              || ['__proto__', 'constructor', 'prototype'].includes(id))
            || Object.keys(payload).some(key => !['bridgeId', 'sessionIds'].includes(key)))
            throw new AttentionError('invalid_attention_request', 'Invalid attention summary target', 400);
          if (!deps.attentionStore) throw new AttentionError('attention_not_ready', 'Attention store is not ready', 503);
          await revalidateAttentionRead(deps, verified);
          const summary: Record<string, { attention: AttentionItem; sequence: number }> = {};
          for (const sessionId of Array.from(new Set(payload.sessionIds as string[]))) {
            const session = await sessionController.get(sessionId);
            if (!session || session.bridgeId !== bridgeId) continue;
            if (session.status !== 'running' && session.status !== 'pending') continue;
            const snapshot = await deps.attentionStore.explicitSnapshot(sessionId);
            if (snapshot.attention) summary[sessionId] = { attention: snapshot.attention, sequence: snapshot.sequence };
          }
          await revalidateAttentionRead(deps, verified);
          response = { requestId: command.requestId, success: true, data: { summary } };
          if (Buffer.byteLength(JSON.stringify({ type: 'command_response', response }), 'utf8') > ATTENTION_SUMMARY_MAX_BYTES) {
            throw new AttentionError(ATTENTION_SUMMARY_TOO_LARGE, 'Attention summary is too large; request fewer sessions.', 413);
          }
          break;
        }
        case 'answer_session_attention': {
          const payload = command.payload as Record<string, unknown>;
          if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).sort().join(',') !== 'answers,bridgeId,eventId,sessionId'
            || payload.bridgeId !== bridgeId || typeof payload.sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(payload.sessionId)
            || typeof payload.eventId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(payload.eventId) || !Array.isArray(payload.answers)) throw new AttentionError('invalid_attention_request', 'Invalid attention answer', 400);
          const session = await sessionController.get(payload.sessionId);
          if (!session || session.bridgeId !== bridgeId) throw new AttentionError('session_unavailable', 'This session is no longer available', 404);
          if (!deps.attentionStore) throw new AttentionError('attention_not_ready', 'Attention store is not ready', 503);
          const { snapshot, waiterLive } = await deps.attentionStore.answer(payload.sessionId, payload.eventId, payload.answers, undefined, { kind: 'human' },
            item => queueAttentionAnswer({ child: session, item, sender: { from: 'browser', fromName: 'You' }, acceptMail: deps.acceptSessionMail }));
          try { deps.publishAttentionChanged?.(payload.sessionId); } catch (err) { console.warn('[Bridge] Could not publish answered attention:', err instanceof Error ? err.message : err); }
          const delivery = waiterLive ? 'waiter' : 'mail';
          response = { requestId: command.requestId, success: true, data: { sessionId: payload.sessionId, ...snapshot, delivery } };
          break;
        }
        case 'create_session': {
          const payload = command.payload as CreateSessionPayload;
          const shellType = payload.shellType !== undefined ? normalizeShellType(payload.shellType) : undefined;
          const session = await sessionController.create(
            {
              command: payload.command,
              prompt: payload.prompt,
              name: payload.name,
              workingDir: payload.workingDir,
              shellType,
              model: payload.model,
              account: payload.account,
              allowedAccounts: payload.allowedAccounts,
              claudeSessionId: payload.claudeSessionId,
              cursorSessionId: payload.cursorSessionId,
              codexSessionId: payload.codexSessionId,
              piSessionId: payload.piSessionId,
              piSessionFile: payload.piSessionFile,
              opencodeSessionId: payload.opencodeSessionId,
              museSessionId: payload.museSessionId,
              grokSessionId: payload.grokSessionId,
              antigravitySessionId: payload.antigravitySessionId,
              env: payload.env,
              projectName: payload.projectName,
              parentBridgeId: payload.parentBridgeId,
              parentSessionId: payload.parentSessionId,
              initialInput: payload.initialInput,
              initialInputDelay: payload.initialInputDelay,
              suppressBriefing: payload.suppressBriefing,
              createMissingWorkingDir: payload.createMissingWorkingDir,
              planItem: planItemFromPayload(payload as { planItem?: unknown }),
              ...(payload.requireGreenPr === true ? { requireGreenPr: true } : {}),
            },
          );
          response = { requestId: command.requestId, success: true, data: { session: toDashboardWireSession(session) } };
          break;
        }

        case 'stop_session': {
          const payload = command.payload as StopSessionPayload;
          if (!payload.sessionId) {
            response = { requestId: command.requestId, success: false, error: 'Missing sessionId' };
            break;
          }

          const { stopped } = await sessionController.stop(payload.sessionId);
          response = { requestId: command.requestId, success: true, data: { stopped } };
          break;
        }

        case 'get_host_resources': {
          if (!deps.hostResources || (command.payload as { bridgeId?: string })?.bridgeId !== bridgeId) throw new Error('Host resources unavailable');
          response = { requestId: command.requestId, success: true, data: { bridgeId, hostResources: await deps.hostResources() } };
          break;
        }
        case 'list_sessions': {
          // Only this bridge's own sessions: a data dir can still hold records of another bridge identity (a shared dir, or one left
          // from before an identity reset), and browsers reject a whole list that names any other bridge.
          const sessions = (await sessionController.list()).filter(session => session.bridgeId === bridgeId);
          response = { requestId: command.requestId, success: true, data: { bridgeId, sessions: sessions.map(toDashboardWireSession) } };
          break;
        }

        case 'get_history': {
          const payload = command.payload as GetHistoryPayload;
          if (!payload.sessionId) {
            response = { requestId: command.requestId, success: false, error: 'Missing sessionId' };
            break;
          }

          const session = await sessionController.get(payload.sessionId);
          response = { requestId: command.requestId, success: true, data: { session: session ? toDashboardWireSession(session) : session } };
          break;
        }

        case 'dismiss_session_block': {
          const payload = command.payload as Record<string, unknown>;
          if (!payload || payload.bridgeId !== bridgeId || typeof payload.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(payload.sessionId)
            || typeof payload.transitionKey !== 'string' || payload.transitionKey.length > 512 || typeof payload.detectedAt !== 'string' || payload.detectedAt.length > 64
            || Object.keys(payload).sort().join(',') !== 'bridgeId,detectedAt,sessionId,transitionKey') throw new Error('Invalid block dismissal');
          const result = await sessionController.dismissBlock(payload.sessionId, bridgeId, payload.transitionKey, payload.detectedAt);
          response = result.ok ? { requestId: command.requestId, success: true, data: { session: toDashboardWireSession(result.session) } }
            : { requestId: command.requestId, success: false, error: result.message };
          break;
        }

        case 'retry_session': {
          const payload = command.payload as StopSessionPayload;

          if (!payload.sessionId) {
            response = { requestId: command.requestId, success: false, error: 'Missing sessionId' };
            break;
          }

          const result = await sessionController.retry(payload.sessionId);
          response = result.ok
            ? { requestId: command.requestId, success: true, data: { session: toDashboardWireSession(result.session) } }
            : { requestId: command.requestId, success: false, error: result.message, ...(result.code === AUTOMATION_REMOVED_CODE ? { data: { code: AUTOMATION_REMOVED_CODE } } : {}) };
          break;
        }

        case 'update_session_parent': {
          const payload = command.payload as UpdateSessionParentPayload;
          if (!payload.sessionId) {
            response = { requestId: command.requestId, success: false, error: 'Missing sessionId' };
            break;
          }
          const hasParentField = Object.prototype.hasOwnProperty.call(
            command.payload,
            'parentSessionId',
          );
          if (
            !hasParentField ||
            (payload.parentSessionId !== null && typeof payload.parentSessionId !== 'string')
          ) {
            response = {
              requestId: command.requestId,
              success: false,
              error: 'Missing or invalid parentSessionId',
            };
            break;
          }

          const result = await sessionController.update(payload.sessionId, {
            parent: { value: payload.parentSessionId, bridgeId: payload.parentBridgeId },
          });
          response = result.ok
            ? { requestId: command.requestId, success: true, data: { session: toDashboardWireSession(result.session) } }
            : { requestId: command.requestId, success: false, error: result.message };
          break;
        }

        case 'move_session_to_project': {
          const payload = command.payload as { sessionId?: unknown; projectName?: unknown; detach?: boolean } | undefined;
          if (typeof payload?.sessionId !== 'string' || !payload.sessionId || (payload.projectName !== null && typeof payload.projectName !== 'string')) {
            response = { requestId: command.requestId, success: false, error: 'Missing or invalid sessionId or projectName' };
            break;
          }

          const result = await sessionController.update(payload.sessionId, { projectName: payload.projectName, ...(payload.detach === true ? { parent: { value: null } } : {}) });
          response = result.ok
            ? { requestId: command.requestId, success: true, data: { session: toDashboardWireSession(result.session) } }
            : { requestId: command.requestId, success: false, error: result.message };
          break;
        }

        case 'rename_session': {
          const payload = command.payload as RenameSessionPayload;
          if (!payload.sessionId || !payload.name) {
            response = { requestId: command.requestId, success: false, error: 'Missing sessionId or name' };
            break;
          }

          const result = await sessionController.update(payload.sessionId, { name: payload.name });
          response = result.ok
            ? { requestId: command.requestId, success: true, data: { session: toDashboardWireSession(result.session) } }
            : { requestId: command.requestId, success: false, error: result.message };
          break;
        }

        case 'remove_session': {
          const payload = command.payload as RemoveSessionPayload;
          if (!payload.sessionId) {
            response = { requestId: command.requestId, success: false, error: 'Missing sessionId' };
            break;
          }

          const { removed } = await sessionController.remove(payload.sessionId, {
            onlyIfFinished: payload.onlyIfFinished,
          });

          response = { requestId: command.requestId, success: true, data: { removed } };
          break;
        }

        case 'bridge_exec': {
          const payload = command.payload as BridgeExecPayload;

          if (process.env.FTOWN_DISABLE_BRIDGE_EXEC === '1') {
            response = {
              requestId: command.requestId,
              success: false,
              error: 'bridge_exec disabled (FTOWN_DISABLE_BRIDGE_EXEC=1)',
            };
            break;
          }

          auditBridgeExec(payload);

          try {
            const { stdout, stderr } = await execAsync(payload.command, {
              cwd: payload.workingDir ?? process.cwd(),
              timeout: payload.timeout ?? 30000,
              maxBuffer: 1024 * 1024,
            });
            response = { requestId: command.requestId, success: true, data: { stdout, stderr, exitCode: 0 } };
          } catch (err) {
            const execErr = err as ExecError;
            response = { requestId: command.requestId, success: true, data: { stdout: execErr.stdout, stderr: execErr.stderr, exitCode: execErr.code } };
          }
          break;
        }

        case 'list_native_sessions': {
          const payload = command.payload as Record<string, unknown>;
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)
            || Object.keys(payload).some(key => !['bridgeId', 'workingDir', 'harness', 'account'].includes(key))
            || payload.bridgeId !== bridgeId || typeof payload.workingDir !== 'string' || !payload.workingDir.trim()
            || (payload.harness !== 'claude' && payload.harness !== 'cursor')
            || (payload.account !== undefined && (typeof payload.account !== 'string' || !/^[a-z0-9-]{1,32}$/.test(payload.account)))
            || (payload.harness === 'cursor' && payload.account !== undefined)) {
            response = { requestId: command.requestId, success: false, error: 'Invalid native session list request', data: { code: 'invalid' } };
            break;
          }
          let accountConfigDir: string | undefined;
          if (payload.harness === 'claude') {
            const accountId = typeof payload.account === 'string' ? payload.account : 'default';
            accountConfigDir = claudeConfigDir(homedir(), {});
            if (accountId !== 'default') {
              const account = loadAccounts().accounts.find(candidate => candidate.id === accountId);
              if (!account) throw new AccountSelectionError('unknown_account', `Unknown account: ${accountId}`);
              if (account.harness !== 'claude') throw new AccountSelectionError('account_harness_mismatch', `Account ${accountId} is for ${account.harness}, not claude`);
              accountConfigDir = account.configDir;
            }
          }
          const list = deps.listNativeSessions ?? listNativeSessions;
          const sessions = await list(payload.harness, payload.workingDir, homedir(), accountConfigDir);
          response = { requestId: command.requestId, success: true, data: { sessions } };
          break;
        }

        case 'clear_terminal': {
          const payload = command.payload as ClearTerminalPayload;
          if (!payload.sessionId) {
            response = { requestId: command.requestId, success: false, error: 'Missing sessionId' };
            break;
          }

          const { cleared } = await sessionController.clearTerminal(payload.sessionId);
          response = { requestId: command.requestId, success: true, data: { cleared } };
          break;
        }

        case 'get_session_usage': {
          const payload = command.payload as GetSessionUsagePayload;
          if (!payload.sessionId) {
            response = { requestId: command.requestId, success: false, error: 'Missing sessionId' };
            break;
          }

          const result = await sessionController.usage(payload.sessionId);
          response = result.ok
            ? { requestId: command.requestId, success: true, data: { usage: result.usage } }
            : { requestId: command.requestId, success: false, error: result.message };
          break;
        }

        case 'handoff_session': {
          const payload = command.payload as HandoffSessionPayload;
          if (!payload.sessionId) {
            response = { requestId: command.requestId, success: false, error: 'Missing sessionId' };
            break;
          }
          if (!deps.handoffSession) {
            response = { requestId: command.requestId, success: false, error: 'Handoff is not available' };
            break;
          }
          const shellType = payload.shellType !== undefined ? normalizeShellType(payload.shellType) : undefined;
          const result = await deps.handoffSession(payload.sessionId, {
            ...(shellType ? { shellType } : {}),
            ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
            ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
          });
          response = { requestId: command.requestId, success: true, data: { session: toDashboardWireSession(result.session) } };
          break;
        }

        case 'get_sessions_usage': {
          const payload = command.payload as GetSessionsUsagePayload;
          if (
            !Array.isArray(payload.sessionIds)
            || payload.sessionIds.length === 0
            || payload.sessionIds.length > 200
            || payload.sessionIds.some((id) => typeof id !== 'string' || !id)
          ) {
            response = { requestId: command.requestId, success: false, error: 'Missing or invalid sessionIds' };
            break;
          }

          const usages = await sessionController.usages(payload.sessionIds);
          response = { requestId: command.requestId, success: true, data: { usages } };
          break;
        }

        default: {
          response = {
            requestId: command.requestId,
            success: false,
            error: `Unknown command type: ${command.type}`,
          };
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      response = err instanceof ProjectBoardChanged
        ? { requestId: command.requestId, success: false, error: err.message, data: { code: 'project_board_changed' } }
        : err instanceof SessionBoardRequestError
        ? { requestId: command.requestId, success: false, error: errorMessage, data: { code: err.code } }
        : err instanceof AttentionError
        ? { requestId: command.requestId, success: false, error: errorMessage, data: { code: err.code } }
        : err instanceof BridgeUpdateError
        ? { requestId: command.requestId, success: false, error: 'Bridge update request could not be completed.', data: { code: err.code } }
        : err instanceof AutomationRemovedError
        ? { requestId: command.requestId, success: false, error: AUTOMATION_REMOVED_MESSAGE, data: { code: AUTOMATION_REMOVED_CODE } }
        : err instanceof WorktreeError
        ? { requestId: command.requestId, success: false, error: errorMessage, data: { code: err.code } }
        : err instanceof PlanItemError
        ? { requestId: command.requestId, success: false, error: errorMessage }
        : err instanceof AccountSelectionError
        ? { requestId: command.requestId, success: false, error: errorMessage, data: { code: err.code } }
        : err instanceof InvalidShellTypeError
        ? { requestId: command.requestId, success: false, error: errorMessage, data: { code: err.code } }
        : err instanceof BridgeSecurityError
        ? { requestId: command.requestId, success: false, error: err.message, data: { code: err.code } }
        : err instanceof WorkingDirMissingError
        ? {
            requestId: command.requestId,
            success: false,
            error: errorMessage,
            data: {
              code: err.code,
              workingDir: err.workingDir,
              canCreate: true,
            },
          }
        : { requestId: command.requestId, success: false, error: errorMessage };
    }

    try {
      await deps.publishCommandResponse(response, verified);
    } catch (err) {
      console.error(`[Bridge] Failed to publish command response:`, err);
    }
  };
}
