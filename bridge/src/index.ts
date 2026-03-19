import { Command as Commander } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { resolve, join, dirname } from 'node:path';
import { hostname as osHostname, homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { CentrifugoClient } from './centrifugo-client.js';
import { ProcessRunner } from './claude-runner.js';
import { SessionStore } from './session-store.js';
import { HookServer } from './hook-server.js';

import type { HookEvent } from './hook-server.js';

import type {
  Command,
  CommandResponse,
  CreateSessionPayload,
  GetHistoryPayload,
  RemoveSessionPayload,
  RenameSessionPayload,
  ResumeSessionPayload,
  RetrySessionPayload,
  Session,
  StopSessionPayload,
} from './types.js';

interface BridgeAuthResponse {
  token: string;
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function installGlobalHooks(): void {
  const hookScript = resolve(join(__dirname, '..', 'hooks', 'notify.sh'));
  const claudeDir = join(homedir(), '.claude');
  const settingsPath = join(claudeDir, 'settings.json');

  const hookEntry = { matcher: '', hooks: [{ type: 'command', command: hookScript, async: true }] };
  const ftownHooks = {
    UserPromptSubmit: [hookEntry],
    Stop: [hookEntry],
    PreToolUse: [hookEntry],
    PostToolUse: [hookEntry],
    Notification: [hookEntry],
  };

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // file doesn't exist or invalid json
  }

  const existingHooks = (settings.hooks ?? {}) as Record<string, unknown>;
  settings.hooks = { ...existingHooks, ...ftownHooks };

  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  console.log(`[Bridge] Installed global hooks at ${settingsPath}`);
}

const program = new Commander();

program
  .name('ftown-bridge')
  .description('Claude Code orchestrator bridge for Centrifugo')
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

    installGlobalHooks();

    const store = new SessionStore(dataDir);

    // Mark any previously "running" sessions as "error" (they died with the old bridge)
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
    const centrifugo = new CentrifugoClient(centrifugoUrl, auth.token);
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

    interface TranscriptEntry {
      type: string;
      message?: {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
        };
      };
    }

    async function parseTranscriptUsage(transcriptPath: string): Promise<{ inputTokens: number; outputTokens: number; totalTokens: number } | undefined> {
      try {
        const content = await readFile(transcriptPath, 'utf-8');
        const lines = content.trim().split('\n');
        let inputTokens = 0;
        let outputTokens = 0;

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as TranscriptEntry;
            if (entry.type === 'assistant' && entry.message?.usage) {
              inputTokens += entry.message.usage.input_tokens ?? 0;
              outputTokens += entry.message.usage.output_tokens ?? 0;
            }
          } catch {
            // skip malformed lines
          }
        }

        if (inputTokens === 0 && outputTokens === 0) return undefined;
        return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
      } catch {
        return undefined;
      }
    }

    hookServer.on('event', (hookEvent: HookEvent) => {
      (async () => {
        if (hookEvent.claudeSessionId) {
          const session = await store.loadSession(hookEvent.sessionId);
          if (session && !session.claudeSessionId) {
            session.claudeSessionId = hookEvent.claudeSessionId;
            await store.saveSession(session);
          }
        }

        const eventData: Record<string, unknown> = {
          type: 'hook_event',
          eventName: hookEvent.eventName,
          data: hookEvent.data,
        };

        if (hookEvent.eventName === 'Stop') {
          const transcriptPath = hookEvent.data.transcript_path as string | undefined;
          if (transcriptPath) {
            const usage = await parseTranscriptUsage(transcriptPath);
            if (usage) {
              eventData.usage = usage;
            }
          }
        }

        await centrifugo.publishHookEvent(userId, hookEvent.sessionId, eventData);
      })().catch((err) => {
        console.error('[Bridge] Failed to handle hook event:', err);
      });
    });

    async function handleCommand(command: Command): Promise<void> {
      console.log(`[Bridge] Received command: ${command.type} (requestId: ${command.requestId})`);

      let response: CommandResponse;

      try {
        switch (command.type) {
          case 'create_session': {
            const payload = command.payload as CreateSessionPayload;

            if (payload.bridgeId && payload.bridgeId !== bridgeId) {
              return;
            }

            if (!payload.prompt && payload.shellType !== 'shell') {
              response = { requestId: command.requestId, success: false, error: 'Missing prompt' };
              break;
            }

            const sessionId = uuidv4();
            const session: Session = {
              id: sessionId,
              name: payload.name ?? (payload.shellType === 'shell' ? 'Shell' : payload.prompt.slice(0, 80)),
              prompt: payload.prompt ?? '',
              status: 'running',
              bridgeId,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              model: payload.model,
              workingDir: payload.workingDir,
              shellType: payload.shellType,
            };

            await store.saveSession(session);
            await centrifugo.publishSessionUpdate(userId, session);

            runner.run(sessionId, payload.prompt, {
              model: payload.model,
              workingDir: payload.workingDir,
              shellType: payload.shellType,
              hookPort,
            });

            // Subscribe to terminal input from UI for this session
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
            const payload = command.payload as RetrySessionPayload;

            if (payload.bridgeId && payload.bridgeId !== bridgeId) {
              return;
            }

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

            existingSession.status = 'running';
            existingSession.updatedAt = new Date().toISOString();
            await store.saveSession(existingSession);
            await centrifugo.publishSessionUpdate(userId, existingSession);

            runner.run(existingSession.id, existingSession.prompt, {
              model: existingSession.model,
              workingDir: existingSession.workingDir,
              shellType: existingSession.shellType,
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

          case 'resume_session': {
            const payload = command.payload as ResumeSessionPayload;

            if (!payload.sessionId) {
              response = { requestId: command.requestId, success: false, error: 'Missing sessionId' };
              break;
            }

            const sessionToResume = await store.loadSession(payload.sessionId);
            if (!sessionToResume) {
              response = { requestId: command.requestId, success: false, error: 'Session not found on this bridge' };
              break;
            }

            if (runner.isRunning(payload.sessionId)) {
              response = { requestId: command.requestId, success: false, error: 'Session is already running' };
              break;
            }

            sessionToResume.status = 'running';
            sessionToResume.updatedAt = new Date().toISOString();
            await store.saveSession(sessionToResume);
            await centrifugo.publishSessionUpdate(userId, sessionToResume);

            if (sessionToResume.claudeSessionId) {
              runner.run(sessionToResume.id, sessionToResume.prompt, {
                model: sessionToResume.model,
                workingDir: sessionToResume.workingDir,
                shellType: sessionToResume.shellType,
                hookPort,
                resumeSessionId: sessionToResume.claudeSessionId,
              });
            } else {
              runner.run(sessionToResume.id, sessionToResume.prompt, {
                model: sessionToResume.model,
                workingDir: sessionToResume.workingDir,
                shellType: sessionToResume.shellType,
                hookPort,
              });
            }

            centrifugo.subscribeToTerminalInput(
              userId, sessionToResume.id,
              (sid, data) => { runner.write(sid, data); },
              (sid, cols, rows) => { runner.resize(sid, cols, rows); },
            );

            response = { requestId: command.requestId, success: true, data: { session: sessionToResume } };
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
    // Ignore replayed history — only process commands arriving after subscribe
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
