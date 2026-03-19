import { Command as Commander } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { resolve } from 'node:path';

import { CentrifugoClient } from './centrifugo-client.js';
import { ClaudeRunner } from './claude-runner.js';
import { SessionStore } from './session-store.js';

import type {
  Command,
  CommandResponse,
  CreateSessionPayload,
  GetHistoryPayload,
  RetrySessionPayload,
  Session,
  StopSessionPayload,
} from './types.js';

interface JwtPayload {
  sub: string;
  [key: string]: unknown;
}

function decodeJwtPayload(token: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
  return JSON.parse(payload) as JwtPayload;
}

function extractUserId(token: string): string {
  const payload = decodeJwtPayload(token);
  if (!payload.sub) {
    throw new Error('JWT does not contain a "sub" claim for userId');
  }
  return payload.sub;
}

const program = new Commander();

program
  .name('ftown-bridge')
  .description('Claude Code orchestrator bridge for Centrifugo')
  .requiredOption('--token <jwt>', 'JWT token for Centrifugo authentication')
  .option('--centrifugo-url <url>', 'Centrifugo WebSocket URL', 'ws://localhost:8000/connection/websocket')
  .option('--data-dir <path>', 'Directory for session data', './data')
  .option('--bridge-id <id>', 'Bridge instance ID')
  .action(async (opts: { token: string; centrifugoUrl: string; dataDir: string; bridgeId?: string }) => {
    const bridgeId = opts.bridgeId ?? uuidv4();
    const dataDir = resolve(opts.dataDir);
    const userId = extractUserId(opts.token);

    console.log('========================================');
    console.log('  ftown-bridge starting');
    console.log(`  Bridge ID:      ${bridgeId}`);
    console.log(`  User ID:        ${userId}`);
    console.log(`  Centrifugo URL: ${opts.centrifugoUrl}`);
    console.log(`  Data dir:       ${dataDir}`);
    console.log('========================================');

    const store = new SessionStore(dataDir);
    const runner = new ClaudeRunner();
    const centrifugo = new CentrifugoClient(opts.centrifugoUrl, opts.token);

    let dataCount = 0;
    runner.on('data', async (sessionId, data) => {
      dataCount++;
      if (dataCount <= 3) {
        console.log(`[Bridge] Terminal data for ${sessionId} (${data.length} bytes)`);
      }
      try {
        await store.appendTerminalData(sessionId, data);
        await centrifugo.publishTerminalData(userId, sessionId, data);
      } catch (err) {
        console.error(`[Bridge] Failed to handle terminal data for session ${sessionId}:`, err);
      }
    });

    runner.on('complete', async (sessionId) => {
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

    async function handleCommand(command: Command): Promise<void> {
      console.log(`[Bridge] Received command: ${command.type} (requestId: ${command.requestId})`);

      let response: CommandResponse;

      try {
        switch (command.type) {
          case 'create_session': {
            const payload = command.payload as CreateSessionPayload;
            if (!payload.prompt) {
              response = { requestId: command.requestId, success: false, error: 'Missing prompt' };
              break;
            }

            const sessionId = uuidv4();
            const session: Session = {
              id: sessionId,
              name: payload.name ?? payload.prompt.slice(0, 80),
              prompt: payload.prompt,
              status: 'running',
              bridgeId,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              model: payload.model,
              workingDir: payload.workingDir,
            };

            await store.saveSession(session);
            await centrifugo.publishSessionUpdate(userId, session);

            runner.run(sessionId, payload.prompt, {
              model: payload.model,
              workingDir: payload.workingDir,
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
            });

            centrifugo.subscribeToTerminalInput(
              userId, existingSession.id,
              (sid, data) => { runner.write(sid, data); },
              (sid, cols, rows) => { runner.resize(sid, cols, rows); },
            );

            response = { requestId: command.requestId, success: true, data: { session: existingSession } };
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
    centrifugo.subscribeToCommands(userId, (command) => {
      handleCommand(command).catch((err) => {
        console.error(`[Bridge] Unhandled error in command handler:`, err);
      });
    });

    const shutdown = (): void => {
      console.log('\n[Bridge] Shutting down...');
      runner.stopAll();
      centrifugo.disconnect();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    console.log('[Bridge] Ready and listening for commands');
  });

program.parse();
