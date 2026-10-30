import { exec } from 'node:child_process';
import type { McpApproval, SecurityPageQuery, VerifiedApplication } from './security/protocol.js';
import type { BridgeSecurityService } from './security/bridge/security.js';
import { BridgeSecurityError } from './security/bridge/errors.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { toWireSession } from './session-wire.js';
import { WorkingDirMissingError } from './create-ftown-session.js';
import { AUTOMATION_REMOVED_CODE, AUTOMATION_REMOVED_MESSAGE, AutomationRemovedError, RETIRED_AUTOMATION_COMMANDS } from './retired-automation.js';
import type { SessionController } from './session-controller.js';
import { AttentionError, type AttentionStore } from './attention-store.js';
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
  relayRequest?: (id: string, payload: Record<string, unknown>) => Promise<unknown>;
  sessionController: SessionController;
  attentionStore?: AttentionStore;
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

    const payloadBridgeId = (command.payload as Record<string, unknown>).bridgeId as string | undefined;
    if (payloadBridgeId && payloadBridgeId !== bridgeId) {
      return;
    }

    let response: CommandResponse;

    try {
      if (RETIRED_AUTOMATION_COMMANDS.has(command.type)) throw new AutomationRemovedError();
      if (deps.security && !verified) throw new Error('approval_required');
      if (deps.security && verified && command.type !== 'security_activate_mcp') await deps.security.revalidate(verified.principal);
      switch (command.type) {
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
        case 'security_revoke':
        case 'security_approve_mcp':
        case 'security_activate_mcp':
        case 'security_account_adopt':
        case 'security_activity': {
          if (!deps.security || !verified || payloadBridgeId !== bridgeId) throw new Error('approval_required');
          const payload = command.payload as Record<string, unknown>;
          let result: unknown;
          if (command.type === 'security_devices') result = { devices: await deps.security.listDevices(verified.principal) };
          else if (command.type === 'security_invite') result = await deps.security.createInvitation(verified.principal, { label: typeof payload.label === 'string' ? payload.label : '' });
          else if (command.type === 'security_revoke') {
            if (typeof payload.endpointId !== 'string') throw new Error('invalid_envelope');
            await deps.security.revokeEndpoint(verified.principal, payload.endpointId); result = { endpointId: payload.endpointId, revoked: true };
          } else if (command.type === 'security_account_adopt') {
            if (Object.keys(payload).some(key => key !== 'bridgeId' && key !== 'head')) throw new Error('invalid_envelope');
            result = { head: await deps.security.adoptAccount(verified.principal, payload.head as import('./security/account-protocol.js').AccountHead) };
          } else if (command.type === 'security_approve_mcp') result = await deps.security.approveMcp(verified.principal, payload.approval as McpApproval);
          else if (command.type === 'security_activate_mcp') {
            if (typeof payload.grantId !== 'string') throw new Error('invalid_envelope');
            result = await deps.security.activateMcp(verified.principal, payload.grantId);
          } else { await deps.security.policy.revalidate(verified.principal, 'admin'); result = await deps.security.audit.list((payload.page ?? {}) as SecurityPageQuery); }
          response = { requestId: command.requestId, success: true, data: result as Record<string, unknown> };
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
          response = { requestId: command.requestId, success: true, data: { sessionId: payload.sessionId, ...snapshot } };
          break;
        }
        case 'mcp_request': {
          if (payloadBridgeId !== bridgeId || !deps.relayRequest) throw new Error('MCP relay unavailable or missing target');
          const data = await deps.relayRequest(command.requestId, command.payload as Record<string, unknown>);
          response = { requestId: command.requestId, success: true, data: data as Record<string, unknown> };
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
      response = err instanceof BridgeUpdateError
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
