#!/usr/bin/env node

import { Command as Commander } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { resolve, dirname, join } from 'node:path';
import { homedir, hostname as osHostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { CentrifugoClient } from './centrifugo-client.js';
import { ProcessRunner } from './claude-runner.js';
import { SessionStore } from './session-store.js';
import { LocalApiServer } from './local-api-server.js';
import { TerminalManager } from './terminal-manager.js';
import { installClaudeHooks } from './hook-installer.js';
import { installCursorHooks } from './cursor-hook-installer.js';
import { installHarness, harnessOnPath, pathHint, writeHarnessAgentGuide, agentGuidePath } from './harness-installer.js';
import { installNotifyScript } from './install-notify-script.js';
import { installFtownSessionsSkill } from './install-ftown-skill.js';
import { installFtownSessionsCli } from './install-ftown-cli.js';
import { registerSessionWorkspace, unregisterSession } from './session-registry.js';
import { createFtownSession } from './create-ftown-session.js';
import { buildSessionCommand } from './agent-commands.js';
import { isTmuxAvailable, killTmuxSession, listFtownTmuxSessions } from './tmux.js';

import type { HookEvent } from './local-api-server.js';

import type {
  BridgeExecPayload,
  ClearTerminalPayload,
  Command,
  CommandResponse,
  CreateSessionPayload,
  GetHistoryPayload,
  RemoveSessionPayload,
  RenameSessionPayload,
  UpdateSessionParentPayload,
  Session,
  StopSessionPayload,
} from './types.js';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface ExecError {
  stdout: string;
  stderr: string;
  code: number;
}

interface BridgeAuthResponse {
  token: string;
  refreshToken: string;
  centrifugoUrl: string;
  userId: string;
}

async function fetchBridgeToken(apiUrl: string, authToken: string, bridgeId: string): Promise<BridgeAuthResponse> {
  const res = await fetch(`${apiUrl}/api/auth/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: authToken,
      bridgeId,
      hostname: osHostname(),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bridge auth failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<BridgeAuthResponse>;
}

const program = new Commander();

program
  .name('ftown-bridge')
  .description('ftown orchestrator bridge for Centrifugo')
  .requiredOption('--token <jwt>', 'Auth token (JWT signed with Centrifugo secret)')
  .requiredOption('--api-url <url>', 'ftown UI API URL (e.g. https://ftown.vercel.app)')
  .option('--data-dir <path>', 'Directory for session data', './data')
  .option('--bridge-id <id>', 'Bridge instance ID')
  .action(async (opts: { token: string; apiUrl: string; dataDir: string; bridgeId?: string }) => {
    const bridgeId = opts.bridgeId ?? uuidv4();
    const dataDir = resolve(opts.dataDir);

    console.log('[Bridge] Authenticating with API...');
    const auth = await fetchBridgeToken(opts.apiUrl, opts.token, bridgeId);
    const userId = auth.userId;
    const centrifugoUrl = auth.centrifugoUrl;

    console.log('========================================');
    console.log('  ftown-bridge starting');
    console.log(`  Bridge ID:      ${bridgeId}`);
    console.log(`  User ID:        ${userId}`);
    console.log(`  Centrifugo URL: ${centrifugoUrl}`);
    console.log(`  Data dir:       ${dataDir}`);
    console.log('========================================');

    async function getToken(): Promise<string> {
      console.log('[Bridge] Refreshing Centrifugo token...');
      const res = await fetch(`${opts.apiUrl}/api/auth/bridge/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          refreshToken: auth.refreshToken,
          bridgeId,
          hostname: osHostname(),
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Token refresh failed (${res.status}): ${body}`);
      }
      const data = await res.json() as { token: string };
      console.log('[Bridge] Token refreshed successfully');
      return data.token;
    }

    const store = new SessionStore(dataDir);
    // Sessions left in a live state by a previous bridge are handled by
    // resurrectSessions() once Centrifugo is connected (tmux reattach,
    // resume respawn, or marked as error).

    const terminalManager = new TerminalManager(50000, 120);

    const runner = new ProcessRunner();
    const centrifugo = new CentrifugoClient(centrifugoUrl, auth.token, getToken);
    const localApiServer = new LocalApiServer();
    const apiToken = randomBytes(32).toString('hex');
    localApiServer.setAuthToken(apiToken);
    const hookPort = await localApiServer.start();
    console.log(`[Bridge] Local API server started on port ${hookPort}`);
    localApiServer.setDependencies(store, runner, centrifugo, userId, terminalManager);

    const bundledNotifyPath = resolve(__dirname, '..', 'hooks', 'notify.sh');
    const notifyScriptPath = installNotifyScript(bundledNotifyPath);
    installClaudeHooks(notifyScriptPath);
    installCursorHooks(notifyScriptPath);

    const wireTerminalInput = (sessionId: string): void => {
      centrifugo.subscribeToTerminalInput(
        userId,
        sessionId,
        (sid, data) => { runner.write(sid, data); },
        (sid, cols, rows) => { handleClientResize(sid, cols, rows); },
        (sid) => { publishScreenDump(sid); },
      );
    };

    localApiServer.setSessionFactory({
      store,
      runner,
      centrifugo,
      userId,
      bridgeId,
      hookPort,
      hookToken: apiToken,
      notifyScriptPath,
      wireTerminalInput,
    });

    const harnessCliPath = resolve(__dirname, 'harness-cli.js');
    const harness = installHarness(harnessCliPath);
    writeHarnessAgentGuide({ wrapperPath: harness.wrapperPath, port: hookPort, bridgeId });
    console.log(`[Bridge] Harness CLI: ${harness.wrapperPath}`);
    console.log(`[Bridge] Agent guide:  ${agentGuidePath()}`);
    if (!harnessOnPath()) {
      const hint = pathHint();
      if (hint) console.log(`[Bridge] ${hint}`);
    }

    const bundledSkillDir = resolve(__dirname, '..', 'skills', 'ftown-sessions');
    installFtownSessionsSkill(bundledSkillDir);

    const cliBundlePath = existsSync(resolve(__dirname, 'ftown-sessions-cli.js'))
      ? resolve(__dirname, 'ftown-sessions-cli.js')
      : resolve(__dirname, '..', 'dist', 'ftown-sessions-cli.js');
    const cliPath = installFtownSessionsCli(cliBundlePath);
    console.log(`[Bridge] Installed CLI at ${cliPath}`);

    const bridgeStateDir = join(homedir(), '.ftown');
    const bridgePointerPath = join(bridgeStateDir, 'bridge.json');
    try {
      mkdirSync(bridgeStateDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        bridgePointerPath,
        JSON.stringify({
          port: hookPort,
          token: apiToken,
          bridgeId,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          harness: harness.wrapperPath,
          harnessCli: harness.cliPath,
        }, null, 2),
        { mode: 0o600 },
      );
      console.log(`[Bridge] Wrote bridge pointer to ${bridgePointerPath}`);
    } catch (err) {
      console.error('[Bridge] Failed to write bridge pointer:', err);
    }

    const cleanupPointer = (): void => {
      try { unlinkSync(bridgePointerPath); } catch { /* already gone */ }
    };
    process.on('exit', cleanupPointer);
    process.on('SIGINT', () => { cleanupPointer(); process.exit(0); });
    process.on('SIGTERM', () => { cleanupPointer(); process.exit(0); });

    function publishScreenDump(sid: string): void {
      // Phase 1: viewport-only dump (~rows*cols bytes) for instant render.
      const viewportRaw = terminalManager.serialize(sid, 0);
      if (viewportRaw) {
        centrifugo.publishTerminalScreen(userId, sid, viewportRaw).catch((err) => {
          console.error(`[Bridge] Failed to publish viewport screen for ${sid}:`, err);
        });
      }

      // Phase 2: full dump with scrollback. Client re-renders on top of phase 1.
      // Cap accounts for ~50% JSON-encoding inflation on ANSI-heavy buffers
      // (each \x1b ->  expands 1 -> 6 bytes), keeping the on-wire
      // Centrifugo frame under websocket_message_size_limit.
      const MAX_BYTES = 2_500_000;
      let scrollback = 20000;
      let raw = terminalManager.serialize(sid, scrollback);
      while (raw && Buffer.byteLength(raw, 'utf8') > MAX_BYTES && scrollback > 100) {
        scrollback = Math.floor(scrollback / 2);
        raw = terminalManager.serialize(sid, scrollback);
      }
      if (!raw) return;
      if (raw === viewportRaw) return;
      centrifugo.publishTerminalScreen(userId, sid, raw).catch((err) => {
        console.error(`[Bridge] Failed to publish full screen for ${sid}:`, err);
      });
    }

    function handleClientResize(sid: string, cols: number, rows: number): void {
      runner.resize(sid, cols, rows);
      terminalManager.resize(sid, cols, rows);
    }

    const outputBuffers = new Map<string, string>();
    const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const FLUSH_INTERVAL_MS = 16;
    const MAX_BUFFER_BYTES = 32_000;

    function flushBuffer(sessionId: string): void {
      const buf = outputBuffers.get(sessionId);
      if (!buf) return;
      outputBuffers.delete(sessionId);
      const timer = flushTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      flushTimers.delete(sessionId);
      store.appendTerminalData(sessionId, buf).catch((err) => {
        console.error(`[Bridge] Failed to store terminal data for ${sessionId}:`, err);
      });
      centrifugo.publishTerminalData(userId, sessionId, buf).catch((err) => {
        console.error(`[Bridge] Failed to publish terminal data for ${sessionId}:`, err);
      });
    }

    runner.on('data', (sessionId, data) => {
      terminalManager.write(sessionId, data);

      const existing = outputBuffers.get(sessionId) ?? '';
      outputBuffers.set(sessionId, existing + data);
      if ((existing.length + data.length) >= MAX_BUFFER_BYTES) {
        flushBuffer(sessionId);
      } else if (!flushTimers.has(sessionId)) {
        flushTimers.set(sessionId, setTimeout(() => flushBuffer(sessionId), FLUSH_INTERVAL_MS));
      }
    });

    // Per-session write queue so concurrent load/modify/save flows (hooks,
    // runner exit handlers, stop_session) cannot interleave and resurrect a
    // stale status.
    const sessionWrites = new Map<string, Promise<void>>();
    function withSessionWrite(sessionId: string, task: () => Promise<void>): Promise<void> {
      const prev = sessionWrites.get(sessionId) ?? Promise.resolve();
      const run = prev.then(task);
      const settled = run.catch(() => undefined);
      sessionWrites.set(sessionId, settled);
      void settled.finally(() => {
        if (sessionWrites.get(sessionId) === settled) {
          sessionWrites.delete(sessionId);
        }
      });
      return run;
    }

    // Synthetic activity reset: some stop paths never produce a real Stop/stop
    // hook (Claude's Stop hook doesn't fire on user interrupt, SessionEnd may be
    // absent, runner exits/crashes). Publishing a synthetic Stop event guarantees
    // every dashboard clears its "thinking"/"tool_use" indicator. Idle is
    // idempotent, so an extra synthetic Stop after a real one is harmless.
    function publishSyntheticStop(sessionId: string, reason: 'complete' | 'error' | 'stopped'): void {
      centrifugo.publishHookEvent(userId, sessionId, {
        type: 'hook_event',
        eventName: 'Stop',
        data: { synthetic: true, reason },
      }).catch((err) => {
        console.error(`[Bridge] Failed to publish synthetic stop for ${sessionId}:`, err);
      });
    }

    runner.on('complete', (sessionId) => {
      flushBuffer(sessionId);
      publishSyntheticStop(sessionId, 'complete');
      withSessionWrite(sessionId, async () => {
        const session = await store.loadSession(sessionId);
        if (session) {
          session.status = 'completed';
          session.updatedAt = new Date().toISOString();
          await store.saveSession(session);
          await centrifugo.publishSessionUpdate(userId, session);
        }
        console.log(`[Bridge] Session ${sessionId} completed`);
      }).catch((err) => {
        console.error(`[Bridge] Failed to handle completion for session ${sessionId}:`, err);
      }).finally(() => {
        unregisterSession(sessionId);
      });
    });

    runner.on('error', (sessionId, error) => {
      flushBuffer(sessionId);
      publishSyntheticStop(sessionId, 'error');
      withSessionWrite(sessionId, async () => {
        const session = await store.loadSession(sessionId);
        if (session) {
          session.status = 'error';
          session.updatedAt = new Date().toISOString();
          await store.saveSession(session);
          await centrifugo.publishSessionUpdate(userId, session);
        }
        console.error(`[Bridge] Session ${sessionId} error:`, error.message);
      }).catch((err) => {
        console.error(`[Bridge] Failed to handle error for session ${sessionId}:`, err);
      }).finally(() => {
        unregisterSession(sessionId);
        terminalManager.destroy(sessionId);
      });
    });

    // Last persisted agent session ids, to skip disk reads on the hot hook path.
    const agentIdCache = new Map<string, { claude?: string; cursor?: string }>();

    async function persistAgentSessionIds(hookEvent: HookEvent): Promise<void> {
      // Workspace-fallback attribution may come from a foreign agent the user
      // ran manually in the same directory; never persist its ids.
      if (hookEvent.source === 'workspace') return;

      const rawClaudeId = hookEvent.data['session_id'];
      const rawCursorId = hookEvent.data['conversation_id'];
      // Claude Code hooks carry session_id; Cursor hooks carry conversation_id.
      const claudeId = typeof rawClaudeId === 'string' && rawClaudeId ? rawClaudeId : undefined;
      const cursorId = typeof rawCursorId === 'string' && rawCursorId ? rawCursorId : undefined;
      if (!claudeId && !cursorId) return;

      const cached = agentIdCache.get(hookEvent.sessionId);
      if (cached
        && (!claudeId || cached.claude === claudeId)
        && (!cursorId || cached.cursor === cursorId)) {
        return;
      }

      const session = await store.loadSession(hookEvent.sessionId);
      if (!session) return;

      let changed = false;
      if (claudeId && session.claudeSessionId !== claudeId) {
        session.claudeSessionId = claudeId;
        changed = true;
      }
      if (cursorId && session.cursorSessionId !== cursorId) {
        session.cursorSessionId = cursorId;
        changed = true;
      }
      if (!changed) {
        agentIdCache.set(hookEvent.sessionId, {
          claude: session.claudeSessionId,
          cursor: session.cursorSessionId,
        });
        return;
      }

      session.updatedAt = new Date().toISOString();
      await store.saveSession(session);
      // Cache only after a successful save, so a failed persist is retried.
      agentIdCache.set(hookEvent.sessionId, {
        claude: session.claudeSessionId,
        cursor: session.cursorSessionId,
      });
      await centrifugo.publishSessionUpdate(userId, session);
    }

    localApiServer.on('event', (hookEvent: HookEvent) => {
      centrifugo.publishHookEvent(userId, hookEvent.sessionId, {
        type: 'hook_event',
        eventName: hookEvent.eventName,
        data: hookEvent.data,
      }).catch((err) => {
        console.error('[Bridge] Failed to handle hook event:', err);
      });

      withSessionWrite(hookEvent.sessionId, () => persistAgentSessionIds(hookEvent)).catch((err) => {
        console.error(`[Bridge] Failed to persist agent session id for ${hookEvent.sessionId}:`, err);
      });
    });

    async function handleCommand(command: Command): Promise<void> {
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
            const session = await createFtownSession(
              {
                store,
                runner,
                centrifugo,
                userId,
                bridgeId,
                hookPort,
                hookToken: apiToken,
                notifyScriptPath,
                wireTerminalInput,
              },
              {
                command: payload.command,
                prompt: payload.prompt,
                name: payload.name,
                workingDir: payload.workingDir,
                shellType: payload.shellType,
                model: payload.model,
                claudeSessionId: payload.claudeSessionId,
                cursorSessionId: payload.cursorSessionId,
                env: payload.env,
                parentSessionId: payload.parentSessionId,
                initialInput: payload.initialInput,
                initialInputDelay: payload.initialInputDelay,
                orchestrator: payload.orchestrator,
              },
            );
            response = { requestId: command.requestId, success: true, data: { session } };
            break;
          }

          case 'stop_session': {
            const payload = command.payload as StopSessionPayload;
            if (!payload.sessionId) {
              response = { requestId: command.requestId, success: false, error: 'Missing sessionId' };
              break;
            }

            const stopped = runner.stop(payload.sessionId);
            if (stopped) {
              publishSyntheticStop(payload.sessionId, 'stopped');
              await withSessionWrite(payload.sessionId, async () => {
                const session = await store.loadSession(payload.sessionId);
                if (session) {
                  session.status = 'completed';
                  session.updatedAt = new Date().toISOString();
                  await store.saveSession(session);
                  await centrifugo.publishSessionUpdate(userId, session);
                }
              });
              unregisterSession(payload.sessionId);
            }

            response = { requestId: command.requestId, success: true, data: { stopped } };
            break;
          }

          case 'list_sessions': {
            const sessions = await store.listSessions();
            response = { requestId: command.requestId, success: true, data: { sessions } };
            break;
          }

          case 'get_history': {
            const payload = command.payload as GetHistoryPayload;
            if (!payload.sessionId) {
              response = { requestId: command.requestId, success: false, error: 'Missing sessionId' };
              break;
            }

            const session = await store.loadSession(payload.sessionId);
            response = { requestId: command.requestId, success: true, data: { session } };
            break;
          }

          case 'retry_session': {
            const payload = command.payload as StopSessionPayload;

            if (!payload.sessionId) {
              response = { requestId: command.requestId, success: false, error: 'Missing sessionId' };
              break;
            }

            const existingSession = await store.loadSession(payload.sessionId);
            if (!existingSession) {
              response = { requestId: command.requestId, success: false, error: 'Session not found' };
              break;
            }

            if (existingSession.status === 'running') {
              response = { requestId: command.requestId, success: false, error: 'Session is already running' };
              break;
            }

            if (!existingSession.command) {
              response = { requestId: command.requestId, success: false, error: 'Session has no command (created before v0.2.0)' };
              break;
            }

            existingSession.status = 'running';
            existingSession.bridgeId = bridgeId;
            existingSession.updatedAt = new Date().toISOString();
            await store.saveSession(existingSession);
            await centrifugo.publishSessionUpdate(userId, existingSession);

            runner.run(existingSession.id, existingSession.command, {
              workingDir: existingSession.workingDir,
              env: existingSession.env,
              hookPort,
              hookToken: apiToken,
              parentSessionId: existingSession.parentSessionId,
            });

            centrifugo.subscribeToTerminalInput(
              userId, existingSession.id,
              (sid, data) => { runner.write(sid, data); },
              (sid, cols, rows) => { handleClientResize(sid, cols, rows); },
              (sid) => { publishScreenDump(sid); },
            );

            response = { requestId: command.requestId, success: true, data: { session: existingSession } };
            break;
          }

          case 'update_session_parent': {
            const payload = command.payload as UpdateSessionParentPayload;
            if (!payload.sessionId) {
              response = { requestId: command.requestId, success: false, error: 'Missing sessionId' };
              break;
            }

            const target = await store.loadSession(payload.sessionId);
            if (!target) {
              response = { requestId: command.requestId, success: false, error: 'Session not found' };
              break;
            }

            if (payload.parentSessionId === null || payload.parentSessionId === undefined || payload.parentSessionId === '') {
              target.parentSessionId = undefined;
            } else if (payload.parentSessionId === target.id) {
              response = { requestId: command.requestId, success: false, error: 'Session cannot be its own parent' };
              break;
            } else {
              const proposed = await store.loadSession(payload.parentSessionId);
              if (!proposed) {
                response = { requestId: command.requestId, success: false, error: 'Parent session not found' };
                break;
              }
              target.parentSessionId = proposed.parentSessionId ?? proposed.id;
            }

            target.updatedAt = new Date().toISOString();
            await store.saveSession(target);
            await centrifugo.publishSessionUpdate(userId, target);

            response = { requestId: command.requestId, success: true, data: { session: target } };
            break;
          }

          case 'rename_session': {
            const payload = command.payload as RenameSessionPayload;
            if (!payload.sessionId || !payload.name) {
              response = { requestId: command.requestId, success: false, error: 'Missing sessionId or name' };
              break;
            }

            const sessionToRename = await store.loadSession(payload.sessionId);
            if (!sessionToRename) {
              response = { requestId: command.requestId, success: false, error: 'Session not found' };
              break;
            }

            sessionToRename.name = payload.name;
            sessionToRename.updatedAt = new Date().toISOString();
            await store.saveSession(sessionToRename);
            await centrifugo.publishSessionUpdate(userId, sessionToRename);

            response = { requestId: command.requestId, success: true, data: { session: sessionToRename } };
            break;
          }

          case 'remove_session': {
            const payload = command.payload as RemoveSessionPayload;
            if (!payload.sessionId) {
              response = { requestId: command.requestId, success: false, error: 'Missing sessionId' };
              break;
            }

            runner.stop(payload.sessionId);

            const sessionToRemove = await store.loadSession(payload.sessionId);
            await store.deleteSession(payload.sessionId);

            if (sessionToRemove) {
              const removedSession: Session = {
                ...sessionToRemove,
                status: 'removed' as Session['status'],
                updatedAt: new Date().toISOString(),
              };
              await centrifugo.publishSessionUpdate(userId, removedSession);
            }

            response = { requestId: command.requestId, success: true, data: { removed: true } };
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

            flushBuffer(payload.sessionId);
            await store.clearTerminalLog(payload.sessionId);
            terminalManager.destroy(payload.sessionId);
            response = { requestId: command.requestId, success: true, data: { cleared: true } };
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
        response = { requestId: command.requestId, success: false, error: errorMessage };
      }

      try {
        await centrifugo.publishCommandResponse(userId, response);
      } catch (err) {
        console.error(`[Bridge] Failed to publish command response:`, err);
      }
    }

    async function markSessionDead(session: Session): Promise<void> {
      session.status = 'error';
      session.updatedAt = new Date().toISOString();
      await store.saveSession(session);
      await centrifugo.publishSessionUpdate(userId, session);
      console.log(`[Bridge] Marked stale session ${session.id} as error`);
    }

    async function resurrectSession(sessionId: string): Promise<void> {
      // Commands run concurrently with the resurrection loop; act on fresh
      // state so a session stopped or removed mid-loop is not respawned.
      const session = await store.loadSession(sessionId);
      if (!session || (session.status !== 'running' && session.status !== 'pending')) return;
      if (runner.isRunning(session.id)) return;

      if (runner.reattach(session.id, {
        workingDir: session.workingDir,
        parentSessionId: session.parentSessionId,
      })) {
        session.status = 'running';
        session.bridgeId = bridgeId;
        session.updatedAt = new Date().toISOString();
        await store.saveSession(session);
        await centrifugo.publishSessionUpdate(userId, session);
        wireTerminalInput(session.id);
        registerSessionWorkspace(session.id, session.workingDir);
        console.log(`[Bridge] Resurrected session ${session.id} via tmux reattach`);
        return;
      }

      const shellType = session.shellType ?? 'claude';
      const canResume = shellType === 'cursor'
        ? Boolean(session.cursorSessionId?.trim())
        : shellType !== 'shell' && shellType !== 'opencode' && Boolean(session.claudeSessionId?.trim());

      if (canResume) {
        // Sessions created with a custom command rerun it verbatim (matching
        // retry_session): injecting --resume into arbitrary commands could
        // break wrappers, and rebuilding would drop their flags.
        const defaultCommand = buildSessionCommand({
          shellType: session.shellType,
          workingDir: session.workingDir,
          model: session.model,
        });
        const isCustomCommand = Boolean(session.command) && session.command !== defaultCommand;
        const resumeCommand = isCustomCommand && session.command
          ? session.command
          : buildSessionCommand({
              shellType: session.shellType,
              workingDir: session.workingDir,
              model: session.model,
              claudeSessionId: session.claudeSessionId,
              cursorSessionId: session.cursorSessionId,
            });
        session.status = 'running';
        session.bridgeId = bridgeId;
        session.runtime = runner.getPreferredRuntime();
        session.updatedAt = new Date().toISOString();
        await store.saveSession(session);
        await centrifugo.publishSessionUpdate(userId, session);
        runner.run(session.id, resumeCommand, {
          workingDir: session.workingDir,
          env: session.env,
          hookPort,
          hookToken: apiToken,
          parentSessionId: session.parentSessionId,
        });
        wireTerminalInput(session.id);
        registerSessionWorkspace(session.id, session.workingDir);
        console.log(`[Bridge] Resurrected session ${session.id} via resume respawn: ${resumeCommand}`);
        return;
      }

      await markSessionDead(session);
    }

    let resurrectionStarted = false;
    async function resurrectSessions(): Promise<void> {
      if (resurrectionStarted) return;
      resurrectionStarted = true;

      const sessions = await store.listSessions();

      // Reap tmux sessions for OUR dead store records (removed records, failed
      // kills) before resurrection re-creates any. Tmux sessions with ids we
      // have no record of are left alone — they may belong to another bridge
      // running on this machine.
      if (isTmuxAvailable()) {
        const deadIds = new Set(
          sessions
            .filter((s) => s.status !== 'running' && s.status !== 'pending')
            .map((s) => s.id),
        );
        for (const tmuxId of listFtownTmuxSessions()) {
          if (deadIds.has(tmuxId)) {
            console.log(`[Bridge] Killing tmux session for dead session ${tmuxId}`);
            await killTmuxSession(tmuxId);
          }
        }
      }

      for (const session of sessions) {
        if (session.status !== 'running' && session.status !== 'pending') continue;
        try {
          await resurrectSession(session.id);
        } catch (err) {
          console.error(`[Bridge] Failed to resurrect session ${session.id}:`, err);
          try {
            const current = await store.loadSession(session.id);
            if (current) await markSessionDead(current);
          } catch (markErr) {
            console.error(`[Bridge] Failed to mark session ${session.id} as error:`, markErr);
          }
        }
      }
    }

    centrifugo.connect();
    centrifugo.joinBridgesChannel(userId, bridgeId);
    centrifugo.subscribeToSessions(userId);

    let ready = false;
    centrifugo.subscribeToCommands(userId, (command) => {
      if (!ready) return;
      handleCommand(command).catch((err) => {
        console.error(`[Bridge] Unhandled error in command handler:`, err);
      });
    });
    setTimeout(() => {
      ready = true;
      console.log('[Bridge] Ready and listening for commands');
      resurrectSessions().catch((err) => {
        console.error('[Bridge] Session resurrection failed:', err);
      });
    }, 2000);

    const shutdown = (): void => {
      console.log('\n[Bridge] Shutting down...');
      localApiServer.stop();
      runner.stopAll();
      centrifugo.disconnect();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program.parse();
