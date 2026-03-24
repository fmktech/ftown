#!/usr/bin/env node

import { Command as Commander } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { resolve, dirname } from 'node:path';
import { hostname as osHostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { CentrifugoClient } from './centrifugo-client.js';
import { ProcessRunner } from './claude-runner.js';
import { SessionStore } from './session-store.js';
import { HookServer } from './hook-server.js';

import type { HookEvent } from './hook-server.js';

import type {
  BridgeExecPayload,
  Command,
  CommandResponse,
  CreateSessionPayload,
  GetDiffPayload,
  GetHistoryPayload,
  RemoveSessionPayload,
  RenameSessionPayload,
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

    const staleSessiones = await store.listSessions();
    for (const s of staleSessiones) {
      if (s.status === 'running' || s.status === 'pending') {
        s.status = 'error';
        s.updatedAt = new Date().toISOString();
        await store.saveSession(s);
        console.log(`[Bridge] Marked stale session ${s.id} as error`);
      }
    }

    const runner = new ProcessRunner();
    const centrifugo = new CentrifugoClient(centrifugoUrl, auth.token, getToken);
    const hookServer = new HookServer();
    const hookPort = await hookServer.start();
    console.log(`[Bridge] Hook server started on port ${hookPort}`);

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
      const existing = outputBuffers.get(sessionId) ?? '';
      outputBuffers.set(sessionId, existing + data);
      if ((existing.length + data.length) >= MAX_BUFFER_BYTES) {
        flushBuffer(sessionId);
      } else if (!flushTimers.has(sessionId)) {
        flushTimers.set(sessionId, setTimeout(() => flushBuffer(sessionId), FLUSH_INTERVAL_MS));
      }
    });

    runner.on('complete', async (sessionId) => {
      flushBuffer(sessionId);
      try {
        const session = await store.loadSession(sessionId);
        if (session) {
          session.status = 'completed';
          session.updatedAt = new Date().toISOString();
          await store.saveSession(session);
          await centrifugo.publishSessionUpdate(userId, session);
          await captureDiff(sessionId);
        }
        console.log(`[Bridge] Session ${sessionId} completed`);
      } catch (err) {
        console.error(`[Bridge] Failed to handle completion for session ${sessionId}:`, err);
      }
    });

    runner.on('error', async (sessionId, error) => {
      flushBuffer(sessionId);
      try {
        const session = await store.loadSession(sessionId);
        if (session) {
          session.status = 'error';
          session.updatedAt = new Date().toISOString();
          await store.saveSession(session);
          await centrifugo.publishSessionUpdate(userId, session);
        }
        console.error(`[Bridge] Session ${sessionId} error:`, error.message);
      } catch (err) {
        console.error(`[Bridge] Failed to handle error for session ${sessionId}:`, err);
      }
    });

    async function findGitRepos(baseDir: string): Promise<string[]> {
      const repos: string[] = [];
      // Check if baseDir itself is a git repo
      try {
        await execAsync('git rev-parse --show-toplevel', { cwd: baseDir });
        repos.push(baseDir);
      } catch {
        // not a git repo
      }
      // Find nested .git directories up to 4 levels deep
      try {
        const { stdout } = await execAsync(
          `find . -maxdepth 4 -name .git -type d 2>/dev/null`,
          { cwd: baseDir, maxBuffer: 512 * 1024 },
        );
        for (const line of stdout.trim().split('\n')) {
          if (!line) continue;
          const repoDir = resolve(baseDir, line, '..');
          if (!repos.includes(repoDir)) repos.push(repoDir);
        }
      } catch {
        // find not available or errored
      }
      return repos;
    }

    async function captureDiff(sessionId: string): Promise<void> {
      const session = await store.loadSession(sessionId);
      if (!session?.workingDir) return;

      const repos = await findGitRepos(session.workingDir);
      let allStat = '';
      let allDiff = '';

      for (const repoDir of repos) {
        try {
          const { stdout: statOutput } = await execAsync('git diff --stat', { cwd: repoDir, maxBuffer: 1024 * 1024 });
          if (!statOutput.trim()) continue;
          const { stdout: fullDiff } = await execAsync('git diff', { cwd: repoDir, maxBuffer: 5 * 1024 * 1024 });

          const relative = repoDir === session.workingDir ? '' : repoDir.replace(session.workingDir + '/', '');
          if (relative) {
            // Prefix file paths in diff so files show as subrepo/path
            const prefixedDiff = fullDiff.replace(
              /^diff --git a\/(.+?) b\/(.+?)$/gm,
              `diff --git a/${relative}/$1 b/${relative}/$2`,
            ).replace(
              /^--- a\/(.+?)$/gm,
              `--- a/${relative}/$1`,
            ).replace(
              /^\+\+\+ b\/(.+?)$/gm,
              `+++ b/${relative}/$1`,
            );
            allStat += `[${relative}] ${statOutput}`;
            allDiff += prefixedDiff;
          } else {
            allStat += statOutput;
            allDiff += fullDiff;
          }
        } catch {
          // not a git repo or git not available
        }
      }

      if (allStat.trim()) {
        await store.saveDiff(sessionId, allDiff);
        session.diffStat = allStat;
        await store.saveSession(session);
        await centrifugo.publishSessionUpdate(userId, session);
      }
    }

    hookServer.on('event', (hookEvent: HookEvent) => {
      centrifugo.publishHookEvent(userId, hookEvent.sessionId, {
        type: 'hook_event',
        eventName: hookEvent.eventName,
        data: hookEvent.data,
      }).catch((err) => {
        console.error('[Bridge] Failed to handle hook event:', err);
      });

      if (hookEvent.eventName === 'PostToolUse') {
        captureDiff(hookEvent.sessionId).catch((err) => {
          console.error('[Bridge] Failed to capture diff:', err);
        });
      }
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

            const sessionId = uuidv4();
            const session: Session = {
              id: sessionId,
              name: payload.name ?? payload.command.slice(0, 80),
              command: payload.command,
              status: 'running',
              bridgeId,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              workingDir: payload.workingDir,
            };

            await store.saveSession(session);
            await centrifugo.publishSessionUpdate(userId, session);

            runner.run(sessionId, payload.command, {
              workingDir: payload.workingDir,
              env: payload.env,
              initialInput: payload.initialInput,
              initialInputDelay: payload.initialInputDelay,
              hookPort,
            });

            centrifugo.subscribeToTerminalInput(
              userId, sessionId,
              (sid, data) => { runner.write(sid, data); },
              (sid, cols, rows) => { runner.resize(sid, cols, rows); },
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
              const session = await store.loadSession(payload.sessionId);
              if (session) {
                session.status = 'completed';
                session.updatedAt = new Date().toISOString();
                await store.saveSession(session);
                await centrifugo.publishSessionUpdate(userId, session);
              }
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
              hookPort,
            });

            centrifugo.subscribeToTerminalInput(
              userId, existingSession.id,
              (sid, data) => { runner.write(sid, data); },
              (sid, cols, rows) => { runner.resize(sid, cols, rows); },
            );

            response = { requestId: command.requestId, success: true, data: { session: existingSession } };
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

          case 'get_diff': {
            const payload = command.payload as GetDiffPayload;
            if (!payload.sessionId) {
              response = { requestId: command.requestId, success: false, error: 'Missing sessionId' };
              break;
            }
            const diff = await store.loadDiff(payload.sessionId);
            response = { requestId: command.requestId, success: true, data: { diff } };
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
    }, 2000);

    const shutdown = (): void => {
      console.log('\n[Bridge] Shutting down...');
      hookServer.stop();
      runner.stopAll();
      centrifugo.disconnect();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program.parse();
