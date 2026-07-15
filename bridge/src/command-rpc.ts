import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { toWireSession } from './session-wire.js';
import { WorkingDirMissingError } from './create-ftown-session.js';
import type { LoopController } from './loop-controller.js';
import type { SessionController } from './session-controller.js';

import type {
  BridgeExecPayload,
  ClearTerminalPayload,
  Command,
  CommandResponse,
  CreateSessionPayload,
  CreateLoopPayload,
  DeleteLoopPayload,
  GetHistoryPayload,
  GetLoopRunsPayload,
  GetSessionUsagePayload,
  RemoveSessionPayload,
  RenameSessionPayload,
  RunLoopNowPayload,
  UpdateLoopPayload,
  UpdateSessionParentPayload,
  StopSessionPayload,
} from './types.js';

const execAsync = promisify(exec);

interface ExecError {
  stdout: string;
  stderr: string;
  code: number;
}

export interface CommandRpcDeps {
  bridgeId: string;
  sessionController: SessionController;
  loopController: LoopController;
  publishCommandResponse: (response: CommandResponse) => Promise<void>;
}

/**
 * Centrifugo commands:rpc adapter: a thin wire-marshaling switch around the
 * transport-agnostic session/loop controllers. Commands addressed to another
 * bridge (payload.bridgeId mismatch) are ignored without a response.
 */
export function createCommandHandler(deps: CommandRpcDeps): (command: Command) => Promise<void> {
  const { bridgeId, sessionController, loopController } = deps;

  return async function handleCommand(command: Command): Promise<void> {
    console.log(`[Bridge] Received command: ${command.type} (requestId: ${command.requestId})`);

    const payloadBridgeId = (command.payload as Record<string, unknown>).bridgeId as string | undefined;
    if (payloadBridgeId && payloadBridgeId !== bridgeId) {
      return;
    }

    let response: CommandResponse;

    try {
      switch (command.type) {
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
              env: payload.env,
              parentSessionId: payload.parentSessionId,
              initialInput: payload.initialInput,
              initialInputDelay: payload.initialInputDelay,
              orchestrator: payload.orchestrator,
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
          response = { requestId: command.requestId, success: true, data: { sessions: sessions.map(toWireSession) } };
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
            : { requestId: command.requestId, success: false, error: result.message };
          break;
        }

        case 'update_session_parent': {
          const payload = command.payload as UpdateSessionParentPayload;
          if (!payload.sessionId) {
            response = { requestId: command.requestId, success: false, error: 'Missing sessionId' };
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

        case 'create_loop': {
          const payload = command.payload as CreateLoopPayload;
          // bridgeId is forced to THIS bridge inside the controller (the routing
          // guard already proved payload.bridgeId === bridgeId), so a loop is
          // always owned by its runner.
          const result = await loopController.create(payload);
          response = result.ok
            ? { requestId: command.requestId, success: true, data: { loop: result.loop } }
            : { requestId: command.requestId, success: false, error: result.message };
          break;
        }

        case 'list_loops': {
          response = { requestId: command.requestId, success: true, data: { loops: loopController.list() } };
          break;
        }

        case 'update_loop': {
          const payload = command.payload as UpdateLoopPayload;
          if (!payload.loopId) {
            response = { requestId: command.requestId, success: false, error: 'Missing loopId' };
            break;
          }
          const result = await loopController.update(payload.loopId, payload.patch);
          response = result.ok
            ? { requestId: command.requestId, success: true, data: { loop: result.loop } }
            : { requestId: command.requestId, success: false, error: result.message };
          break;
        }

        case 'delete_loop': {
          const payload = command.payload as DeleteLoopPayload;
          if (!payload.loopId) {
            response = { requestId: command.requestId, success: false, error: 'Missing loopId' };
            break;
          }
          const { removed } = await loopController.delete(payload.loopId);
          response = { requestId: command.requestId, success: true, data: { removed } };
          break;
        }

        case 'run_loop_now': {
          const payload = command.payload as RunLoopNowPayload;
          if (!payload.loopId) {
            response = { requestId: command.requestId, success: false, error: 'Missing loopId' };
            break;
          }
          const outcome = await loopController.runNow(payload.loopId);
          response = outcome.fired
            ? { requestId: command.requestId, success: true, data: { fired: true } }
            : { requestId: command.requestId, success: true, data: { fired: false, reason: outcome.reason } };
          break;
        }

        case 'get_loop_runs': {
          const payload = command.payload as GetLoopRunsPayload;
          if (!payload.loopId) {
            response = { requestId: command.requestId, success: false, error: 'Missing loopId' };
            break;
          }
          const runs = await loopController.runs(payload.loopId);
          response = { requestId: command.requestId, success: true, data: { runs } };
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
      response = err instanceof WorkingDirMissingError
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
      await deps.publishCommandResponse(response);
    } catch (err) {
      console.error(`[Bridge] Failed to publish command response:`, err);
    }
  };
}
