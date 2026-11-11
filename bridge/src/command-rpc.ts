import { exec } from 'node:child_process';
import type { VerifiedApplication } from './security/protocol.js';
import type { BridgeSecurityService } from './security/bridge/security.js';
import { BridgeSecurityError } from './security/bridge/errors.js';
import { ledgerChainPage, ledgerHeadAnswer, parseLedgerChainQuery, parseLedgerHeadQuery, type HeldLedger } from './security/bridge/ledger-rpc.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { prReviewGeneration, toWireSession } from './session-wire.js';
import { normalizePullRequestUrl } from './pull-request-url.js';
import type { PullRequestStatusService } from './pull-request-status.js';
import type { PrReviewService, PrReviewRequest, PrReviewChunkRequest } from './pull-request-review-protocol.js';
import { PR_REVIEW_CHUNK_BYTES } from './pull-request-review-protocol.js';
import { WorkingDirMissingError } from './create-ftown-session.js';
import { AUTOMATION_REMOVED_CODE, AUTOMATION_REMOVED_MESSAGE, AutomationRemovedError, RETIRED_AUTOMATION_COMMANDS } from './retired-automation.js';
import type { SessionController } from './session-controller.js';
import type { Session } from './types.js';
import type { SessionMessageAccepted, SessionMessageErrorCode } from './session-inbox-protocol.js';
import { AttentionError, type AttentionStore } from './attention-store.js';
import { formatAttentionAnswerMail } from './attention-prompt.js';
import type { AttentionAnswerDelivery } from './attention-prompt-protocol.js';
import { BridgeUpdateError, type BridgeUpdateCoordinator } from './bridge-update.js';
import type { UpdateEffects } from './update-effects.js';
import { validPreviewId, validRevision } from './session-preview.js';
import { PREVIEW_CHUNK_BYTES } from './preview-protocol.js';

import type {
  BridgeExecPayload,
  ClearTerminalPayload,
  Command,
  CommandResponse,
  CreateSessionPayload,
  GetHistoryPayload,
  GetSessionUsagePayload,
  GetSessionsUsagePayload,
  RemoveSessionPayload,
  RenameSessionPayload,
  UpdateSessionParentPayload,
  StopSessionPayload,
} from './types.js';

const execAsync = promisify(exec);

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

export interface CommandRpcDeps {
  bridgeId: string;
  security?: BridgeSecurityService;
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
  updateEffects?: UpdateEffects;
  publishCommandResponse: (response: CommandResponse, verified?: VerifiedApplication) => Promise<void>;
}

/**
 * Centrifugo commands:rpc adapter: a thin wire-marshaling switch around the
 * transport-agnostic session controller. Commands addressed to another
 * bridge (payload.bridgeId mismatch) are ignored without a response.
 */
export function createCommandHandler(deps: CommandRpcDeps): (command: Command, verified?: VerifiedApplication) => Promise<void> {
  const { bridgeId, sessionController } = deps;

  return async function handleCommand(command: Command, verified?: VerifiedApplication): Promise<void> {
    console.log(`[Bridge] Received command: ${command.type} (requestId: ${command.requestId})`);

    const payloadBridgeId = command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
      ? (command.payload as Record<string, unknown>).bridgeId as string | undefined : undefined;
    if (payloadBridgeId && payloadBridgeId !== bridgeId) {
      return;
    }

    let response: CommandResponse;

    try {
      if (RETIRED_AUTOMATION_COMMANDS.has(command.type)) throw new AutomationRemovedError();
      if (deps.security && !verified) throw new Error('approval_required');
      if (deps.security && verified) await deps.security.revalidate(verified.principal);
      switch (command.type) {
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
          const common = ['bridgeId', 'sessionId', 'previewId'];
          const allowed = command.type === 'session_preview_status' ? [...common, 'knownRevision'] : [...common, 'revision', 'offset'];
          if (keys.some(key => !allowed.includes(key)) || !('bridgeId' in payload) || payload.bridgeId !== bridgeId
            || !('sessionId' in payload) || typeof payload.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(payload.sessionId)
            || !('previewId' in payload) || !validPreviewId(payload.previewId)
            || (command.type === 'session_preview_status' && 'knownRevision' in payload && !validRevision(payload.knownRevision))
            || (command.type === 'session_preview_chunk' && (!('revision' in payload) || !validRevision(payload.revision)
              || !('offset' in payload) || typeof payload.offset !== 'number' || !Number.isSafeInteger(payload.offset)
              || payload.offset < 0 || payload.offset % PREVIEW_CHUNK_BYTES !== 0))) {
            response = { requestId: command.requestId, success: false, error: 'Invalid preview request', data: { code: 'invalid' } };
            break;
          }
          const result = command.type === 'session_preview_status'
            ? await sessionController.getPreviewStatus(payload.sessionId, payload.previewId, 'knownRevision' in payload && typeof payload.knownRevision === 'string' ? payload.knownRevision : undefined)
            : await sessionController.getPreviewChunk(payload.sessionId, payload.previewId, 'revision' in payload && typeof payload.revision === 'string' ? payload.revision : '', 'offset' in payload && typeof payload.offset === 'number' ? payload.offset : -1);
          response = result.ok ? { requestId: command.requestId, success: true, data: result.preview }
            : { requestId: command.requestId, success: false, error: result.message, data: { code: result.code } };
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
            || Object.keys(payload).some(key => !allowed.includes(key))) throw new Error('Invalid attention target');
          if (command.type === 'resolve_session_attention' && (typeof payload.eventId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(payload.eventId))) throw new Error('Invalid attention eventId');
          const session = await sessionController.get(payload.sessionId);
          if (!session || session.bridgeId !== bridgeId) throw new Error('Unknown session');
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
        case 'answer_session_attention': {
          const payload = command.payload as Record<string, unknown>;
          if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).sort().join(',') !== 'answers,bridgeId,eventId,sessionId'
            || payload.bridgeId !== bridgeId || typeof payload.sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(payload.sessionId)
            || typeof payload.eventId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(payload.eventId) || !Array.isArray(payload.answers)) throw new Error('Invalid attention answer');
          const session = await sessionController.get(payload.sessionId);
          if (!session || session.bridgeId !== bridgeId) throw new Error('Unknown session');
          if (!deps.attentionStore) throw new AttentionError('attention_not_ready', 'Attention store is not ready', 503);
          const { item, snapshot, waiterLive } = await deps.attentionStore.answer(payload.sessionId, payload.eventId, payload.answers);
          let delivery: AttentionAnswerDelivery;
          if (item.prompt?.channel === 'hook' || waiterLive) delivery = 'waiter';
          else {
            try {
              if (!deps.acceptSessionMail || !item.prompt || !item.answer) throw new Error('Mail is not ready on this bridge');
              const accepted = await deps.acceptSessionMail(session, {
                from: 'browser', fromName: 'You', type: 'message', threadId: `attention:${payload.eventId}`,
                body: formatAttentionAnswerMail({ attentionId: item.id, title: item.title || undefined, prompt: item.prompt, answers: item.answer.answers }),
              });
              if (!accepted.ok) throw new Error(accepted.error);
              delivery = 'mail';
            } catch (err) {
              console.error('[Bridge] Failed to mail attention answer:', err instanceof Error ? err.message : err);
              delivery = 'mail_failed';
            }
          }
          response = { requestId: command.requestId, success: true, data: { sessionId: payload.sessionId, ...snapshot, delivery } };
          break;
        }
        case 'create_session': {
          const payload = command.payload as CreateSessionPayload;
          const session = await sessionController.create(
            {
              command: payload.command,
              prompt: payload.prompt,
              name: payload.name,
              workingDir: payload.workingDir,
              shellType: payload.shellType,
              model: payload.model,
              claudeSessionId: payload.claudeSessionId,
              cursorSessionId: payload.cursorSessionId,
              codexSessionId: payload.codexSessionId,
              opencodeSessionId: payload.opencodeSessionId,
              museSessionId: payload.museSessionId,
              env: payload.env,
              parentSessionId: payload.parentSessionId,
              initialInput: payload.initialInput,
              initialInputDelay: payload.initialInputDelay,
              suppressBriefing: payload.suppressBriefing,
              createMissingWorkingDir: payload.createMissingWorkingDir,
            },
          );
          response = { requestId: command.requestId, success: true, data: { session: toWireSession(session) } };
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

        case 'list_sessions': {
          const sessions = await sessionController.list();
          response = { requestId: command.requestId, success: true, data: { bridgeId, sessions: sessions.map(toWireSession) } };
          break;
        }

        case 'get_history': {
          const payload = command.payload as GetHistoryPayload;
          if (!payload.sessionId) {
            response = { requestId: command.requestId, success: false, error: 'Missing sessionId' };
            break;
          }

          const session = await sessionController.get(payload.sessionId);
          response = { requestId: command.requestId, success: true, data: { session: session ? toWireSession(session) : session } };
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
            ? { requestId: command.requestId, success: true, data: { session: toWireSession(result.session) } }
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
            parent: { value: payload.parentSessionId },
          });
          response = result.ok
            ? { requestId: command.requestId, success: true, data: { session: toWireSession(result.session) } }
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
            ? { requestId: command.requestId, success: true, data: { session: toWireSession(result.session) } }
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
      response = err instanceof AttentionError
        ? { requestId: command.requestId, success: false, error: errorMessage, data: { code: err.code } }
        : err instanceof BridgeUpdateError
        ? { requestId: command.requestId, success: false, error: 'Bridge update request could not be completed.', data: { code: err.code } }
        : err instanceof AutomationRemovedError
        ? { requestId: command.requestId, success: false, error: AUTOMATION_REMOVED_MESSAGE, data: { code: AUTOMATION_REMOVED_CODE } }
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
