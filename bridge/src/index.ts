#!/usr/bin/env node

import { Command as Commander } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { resolve, dirname, join } from 'node:path';
import { homedir, hostname as osHostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { cleanup as ndcCleanup } from 'node-datachannel';

import { CentrifugoClient } from './centrifugo-client.js';
import { WatchRegistry } from './direct-transport/watch-registry.js';
import { DirectPeerManager } from './direct-transport/peer-manager.js';
import { PublishRouter } from './direct-transport/publish-router.js';
import { LoopbackPeerServer } from './direct-transport/loopback-server.js';
import { toWireSession } from './session-wire.js';
import { ProcessRunner } from './claude-runner.js';
import { SessionStore } from './session-store.js';
import { MailStore } from './mail-store.js';
import { LocalApiServer } from './local-api-server.js';
import { TerminalManager } from './terminal-manager.js';
import { installClaudeHooks } from './hook-installer.js';
import { installCursorHooks } from './cursor-hook-installer.js';
import { codexBinaryAvailable, ensureCodexHooks } from './codex-installer.js';
import { installHarness, harnessOnPath, pathHint, writeHarnessAgentGuide, agentGuidePath } from './harness-installer.js';
import type { HarnessInstallResult } from './harness-installer.js';
import { installNotifyScript } from './install-notify-script.js';
import { installFtownSkill, removeFtownSkill } from './install-ftown-skill.js';
import { installFtownSessionsCli } from './install-ftown-cli.js';
import { installFtownWorkflowsCli } from './install-ftown-workflows-cli.js';
import { installFtownEnvCli } from './install-ftown-env-cli.js';
import { installFtownCommandCli } from './install-ftown-command-cli.js';
import { ensureFtownOnPath } from './ensure-ftown-path.js';
import { unregisterSession } from './session-registry.js';
import { createFtownSession, type CreateFtownSessionDeps } from './create-ftown-session.js';
import { createCommandHandler } from './command-rpc.js';
import { removeFtownSession } from './remove-ftown-session.js';
import { SessionResurrection } from './session-resurrection.js';
import { TerminalPump } from './terminal-pump.js';
import { collectSessionUsage } from './usage-collector.js';
import { AgentSessionIdPersister } from './session-ids.js';
import { fetchBridgeToken, refreshBridgeToken, type BridgeAuthResponse } from './bridge-auth.js';
import { listLoops } from './loop-store.js';
import { LoopScheduler, LOOP_TICK_INTERVAL_MS } from './loop-scheduler.js';
import { LoopController } from './loop-controller.js';
import { SessionController } from './session-controller.js';
import { runPairing } from './pairing-client.js';

import type { HookEvent } from './local-api-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_API_URL = 'https://ftown.ia.br';

/**
 * Default data dir is ~/.ftown/data (machine-stable, like the rest of ~/.ftown).
 * Older bridges defaulted to ./data relative to the launch cwd — if that legacy
 * dir holds sessions and the new default does not exist yet, migrate it once so
 * an upgraded bridge still resurrects its sessions.
 */
function resolveDefaultDataDir(): string {
  const defaultDir = join(homedir(), '.ftown', 'data');
  const legacyDir = resolve('./data');
  if (!existsSync(defaultDir) && existsSync(join(legacyDir, 'sessions'))) {
    try {
      mkdirSync(dirname(defaultDir), { recursive: true });
      renameSync(legacyDir, defaultDir);
      console.log(`[Bridge] Migrated legacy data dir ${legacyDir} -> ${defaultDir}`);
    } catch (err) {
      console.error(
        `[Bridge] Failed to migrate legacy data dir (${err instanceof Error ? err.message : String(err)}); using ${legacyDir}`,
      );
      return legacyDir;
    }
  }
  return defaultDir;
}

const program = new Commander();

program
  .name('ftown-bridge')
  .description('ftown orchestrator bridge for Centrifugo')
  .option('--token <jwt>', 'Bridge bootstrap token from the ftown dashboard (short-lived; used once to onboard, then a rotating refresh token is stored). Optional: with no token and no stored refresh token, the bridge runs interactive device pairing instead.')
  .option('--api-url <url>', 'ftown UI API URL', DEFAULT_API_URL)
  .option('--data-dir <path>', 'Directory for session data (default: ~/.ftown/data)')
  .option('--bridge-id <id>', 'Bridge instance ID (default: persisted per data dir)')
  .action(async (opts: { token?: string; apiUrl: string; dataDir?: string; bridgeId?: string }) => {
    const dataDir = opts.dataDir ? resolve(opts.dataDir) : resolveDefaultDataDir();
    // Bridge identity sticks to the data dir so a plain restart auto-resumes:
    // same id → same dashboard entry, sessions reattach without any flags.
    const bridgeIdPath = join(dataDir, 'bridge-id');
    let persistedBridgeId: string | undefined;
    try {
      persistedBridgeId = readFileSync(bridgeIdPath, 'utf8').trim() || undefined;
    } catch {
      persistedBridgeId = undefined;
    }
    const bridgeId = opts.bridgeId ?? persistedBridgeId ?? uuidv4();
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(bridgeIdPath, `${bridgeId}\n`, { mode: 0o600 });
    } catch (err) {
      console.error('[Bridge] Failed to persist bridge id:', err instanceof Error ? err.message : String(err));
    }

    // The local API server binds before the token fetch: its ephemeral port and
    // the per-process loopback nonce ride the auth request so the UI can embed
    // them in the Centrifugo connection JWT `info` claim (presence advert, L2).
    // Binding needs no post-auth state — dependencies/routes are wired later.
    const localApiServer = new LocalApiServer();
    const apiToken = randomBytes(32).toString('hex');
    localApiServer.setAuthToken(apiToken);
    const hookPort = await localApiServer.start();
    console.log(`[Bridge] Local API server started on port ${hookPort}`);
    const localNonce = randomBytes(16).toString('hex');

    // The bootstrap token (--token) is single-use and short-lived (F1). Once a
    // bridge has onboarded it persists its rotating refresh token (F3) and
    // resumes from that on restart, so the bootstrap token is never reused.
    const local = { localPort: hookPort, localNonce };
    const refreshTokenPath = join(dataDir, 'refresh-token');

    let persistedRefreshToken: string | undefined;
    try {
      persistedRefreshToken = readFileSync(refreshTokenPath, 'utf8').trim() || undefined;
    } catch {
      persistedRefreshToken = undefined;
    }

    const persistRefreshToken = (token: string): void => {
      try {
        writeFileSync(refreshTokenPath, `${token}\n`, { mode: 0o600 });
      } catch (err) {
        console.error(
          '[Bridge] Failed to persist refresh token:',
          err instanceof Error ? err.message : String(err),
        );
      }
    };

    // Onboarding precedence (P7): stored refresh token → else --token exchange →
    // else interactive device pairing. Pairing yields the SAME token bundle shape
    // as /api/auth/bridge, so all three paths converge on `auth` and the identical
    // refresh-token persist/resume logic below.
    const onboard = async (): Promise<BridgeAuthResponse> => {
      if (opts.token) {
        console.log('[Bridge] Authenticating with API...');
        return fetchBridgeToken(opts.apiUrl, opts.token, bridgeId, local);
      }
      console.log('[Bridge] No bootstrap token or stored session — starting device pairing...');
      return runPairing({
        apiUrl: opts.apiUrl,
        bridgeId,
        hostname: osHostname(),
        platform: process.platform,
        localPort: local.localPort,
        localNonce: local.localNonce,
        log: (msg) => console.log(msg),
      });
    };

    let auth: BridgeAuthResponse;
    if (persistedRefreshToken) {
      console.log('[Bridge] Resuming from stored refresh token...');
      try {
        auth = await refreshBridgeToken(opts.apiUrl, persistedRefreshToken, bridgeId, local);
      } catch (err) {
        console.warn(
          '[Bridge] Stored refresh token rejected, falling back to bootstrap token / pairing:',
          err instanceof Error ? err.message : String(err),
        );
        auth = await onboard();
      }
    } else {
      auth = await onboard();
    }
    let currentRefreshToken = auth.refreshToken;
    persistRefreshToken(currentRefreshToken);

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
      // Same process ⇒ same port/nonce; the refresh route re-embeds them.
      const refreshed = await refreshBridgeToken(opts.apiUrl, currentRefreshToken, bridgeId, local);
      // F3: the refresh token rotated — adopt and persist the new one so the
      // next refresh (and any restart) uses it. The old one is now rejected.
      currentRefreshToken = refreshed.refreshToken;
      persistRefreshToken(currentRefreshToken);
      console.log('[Bridge] Token refreshed successfully');
      return refreshed.token;
    }

    const store = new SessionStore(dataDir);
    // Sessions left in a live state by a previous bridge are handled by
    // resurrectSessions() once Centrifugo is connected (tmux reattach,
    // resume respawn, or marked as error).

    const terminalManager = new TerminalManager(50000, 120);

    const runner = new ProcessRunner();
    const centrifugo = new CentrifugoClient(centrifugoUrl, auth.token, getToken, {
      // On a transport reconnect, re-publish the session snapshot. The UI does
      // not re-request its list on reconnect, so without this its session list
      // goes stale/empty after a Centrifugo blip until a page reload.
      onReconnect: async () => {
        const sessions = await store.listSessions();
        for (const session of sessions) {
          await centrifugo.publishSessionUpdate(userId, session);
        }
        const loops = listLoops();
        for (const loop of loops) {
          await centrifugo.publishLoopUpdate(userId, loop);
        }
        console.log(
          `[Bridge] Re-synced ${sessions.length} session(s) and ${loops.length} loop(s) after Centrifugo reconnect`,
        );
      },
    });
    // Direct transport (WebRTC DataChannel) data plane. Peers attach per session;
    // terminal output/screen fan out to them directly, and to Centrifugo only when
    // the session has an unexpired remote watcher (R2). Signaling and watch
    // heartbeats ride the existing commands:rpc channel.
    const watchRegistry = new WatchRegistry();
    const directPeers = new DirectPeerManager({
      bridgeId,
      sendSignal: (msg) => {
        centrifugo.publishSignal(userId, msg).catch((err) => {
          console.error('[Bridge] Failed to publish WebRTC signal:', err);
        });
      },
      onInput: (sid, data) => { runner.write(sid, data); },
      onResize: (sid, cols, rows) => { handleClientResize(sid, cols, rows); },
      onAttach: (sid) => terminalManager.serialize(sid, 20000) ?? '',
    });
    // Loopback WebSocket rung: same DirectMessage protocol as WebRTC, tunneled
    // over TCP on the existing 127.0.0.1 local API server. Bypasses VPN/endpoint
    // filters that kill UDP hairpin. Input/resize/attach feed the SAME sinks as
    // the WebRTC peer manager; upgrades are gated on the per-process nonce (L1/L2).
    let apiOrigin = '';
    try { apiOrigin = new URL(opts.apiUrl).origin; } catch { /* leave empty; only localhost origins accepted */ }
    const loopbackServer = new LoopbackPeerServer({
      bridgeId,
      nonce: localNonce,
      allowedOrigins: apiOrigin ? [apiOrigin] : [],
      onInput: (sid, data) => { runner.write(sid, data); },
      onResize: (sid, cols, rows) => { handleClientResize(sid, cols, rows); },
      onAttach: (sid) => terminalManager.serialize(sid, 20000) ?? '',
    });
    const publishRouter = new PublishRouter({
      registry: watchRegistry,
      peerManager: directPeers,
      loopback: loopbackServer,
      centrifugo,
      userId,
      // Watch messages fan out to every bridge on commands:rpc; only register
      // watchers for sessions this bridge actually serves terminal data for.
      isKnownSession: (sid) => runner.isRunning(sid) || terminalManager.has(sid),
    });
    // Every NEW remote watcher (first, each additional distinct client, or a
    // post-expiry re-registration) ⇒ push a full screen resync so the joining
    // Centrifugo-fallback client renders before incremental output (R1). The
    // dump is channel-wide; existing viewers re-render idempotently.
    watchRegistry.onNewWatcher((sid) => publishScreenDump(sid));

    // Bind the loopback WS upgrade handler onto the already-listening server.
    const loopbackHttpServer = localApiServer.getHttpServer();
    if (loopbackHttpServer) {
      loopbackServer.attach(loopbackHttpServer);
      console.log(`[Bridge] Loopback WS rung ready at ws://127.0.0.1:${hookPort}/ws`);
    }
    localApiServer.setDependencies(store, runner, centrifugo, userId, terminalManager);
    const mailStore = new MailStore((sessionId) => store.sessionDir(sessionId));
    localApiServer.setMailStore(mailStore);

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

    const sessionFactoryDeps: CreateFtownSessionDeps = {
      store,
      runner,
      centrifugo,
      userId,
      bridgeId,
      hookPort,
      hookToken: apiToken,
      notifyScriptPath,
      wireTerminalInput,
    };
    localApiServer.setSessionFactory(sessionFactoryDeps);

    // Scheduled-loops engine. It fires loop runs IN-PROCESS via createFtownSession
    // (avoiding the external-caller parent-identity restriction) and reaps old runs
    // via removeFtownSession — both injected as closures over the real deps.
    const scheduler = new LoopScheduler({
      store,
      runner,
      centrifugo,
      userId,
      spawnSession: (input) => createFtownSession(sessionFactoryDeps, input),
      removeSession: (id, options) => removeFtownSession({ store, runner, centrifugo, userId }, id, options),
    });
    localApiServer.setLoopApi({ bridgeId, scheduler });

    // Terminal output pump: buffers runner PTY output and owns the runner
    // 'complete'/'error' lifecycle handlers (loop-run status transitions the
    // loop scheduler depends on).
    const pump = new TerminalPump({
      store,
      terminalManager,
      publishTerminalData: (sid, data) => publishRouter.publishTerminalData(sid, data),
      publishSessionUpdate: (session) => centrifugo.publishSessionUpdate(userId, session),
      publishHookEvent: (sid, event) => centrifugo.publishHookEvent(userId, sid, event),
      unregisterSession: (sid) => unregisterSession(sid),
      collectUsage: (session) => collectSessionUsage(session),
    });
    pump.attach(runner);

    // Resurrection engine for sessions left live by a previous bridge process.
    const resurrection = new SessionResurrection({
      store,
      runner,
      bridgeId,
      sessionFactoryDeps,
      publishSessionUpdate: (session) => centrifugo.publishSessionUpdate(userId, session),
      wireTerminalInput,
    });

    // Persists Claude/Cursor/Codex-native session ids from hook events.
    const agentIdPersister = new AgentSessionIdPersister({
      store,
      publishSessionUpdate: (session) => centrifugo.publishSessionUpdate(userId, session),
    });

    // Transport-agnostic controllers: each loop/session operation is defined
    // once here; the RPC switch below and the local HTTP router are thin
    // adapters that only marshal wire formats around these calls.
    const loopController = new LoopController({
      bridgeId,
      scheduler,
      isSessionRunning: (sid) => runner.isRunning(sid),
      publishLoopUpdate: (loop) => centrifugo.publishLoopUpdate(userId, loop),
      publishLoopRemoved: (loopId) => centrifugo.publishLoopRemoved(userId, loopId),
      listWireSessions: async () => (await store.listSessions()).map(toWireSession),
      loadTerminalLog: (sid) => store.loadTerminalLog(sid),
    });
    const sessionController = new SessionController({
      store,
      runner,
      publishSessionUpdate: (session) => centrifugo.publishSessionUpdate(userId, session),
      removeSession: (id, options) => removeFtownSession({ store, runner, centrifugo, userId }, id, options),
      sessionFactory: sessionFactoryDeps,
      collectUsage: (session) => collectSessionUsage(session),
      publishSyntheticStop: (sid, reason) => pump.publishSyntheticStop(sid, reason),
      withSessionWrite: (sid, task) => pump.withSessionWrite(sid, task),
      unregisterSession: (sid) => unregisterSession(sid),
      flushTerminalBuffer: (sid) => pump.flush(sid),
      destroyTerminal: (sid) => terminalManager.destroy(sid),
    });

    // Compiled sibling of this module (running from dist), else the sibling
    // dist/ directory (running from src via `tsx watch` in dev). If neither
    // exists — dev mode without a build — skip installation instead of
    // crashing; the harness CLI is a packaged artifact, not source.
    const harnessCliPath = existsSync(resolve(__dirname, 'harness-cli.js'))
      ? resolve(__dirname, 'harness-cli.js')
      : resolve(__dirname, '..', 'dist', 'harness-cli.js');
    let harness: HarnessInstallResult | undefined;
    if (existsSync(harnessCliPath)) {
      harness = installHarness(harnessCliPath);
      // Codex reads Claude-style hooks from ~/.codex/hooks.json; skip silently
      // when the codex binary is not installed on this machine.
      if (await codexBinaryAvailable()) {
        ensureCodexHooks(harness.wrapperPath, notifyScriptPath);
      }
      writeHarnessAgentGuide({ wrapperPath: harness.wrapperPath, port: hookPort, bridgeId });
      console.log(`[Bridge] Harness CLI: ${harness.wrapperPath}`);
      console.log(`[Bridge] Agent guide:  ${agentGuidePath()}`);
      if (!harnessOnPath()) {
        const hint = pathHint();
        if (hint) console.log(`[Bridge] ${hint}`);
      }
    } else {
      console.warn('[Bridge] harness CLI not built (run `npm run build`) — skipping harness install in dev mode');
    }

    installFtownSkill('ftown', resolve(__dirname, '..', 'skills', 'ftown'));
    installFtownSkill('factory', resolve(__dirname, '..', 'skills', 'factory'));
    installFtownSkill('fticket', resolve(__dirname, '..', 'skills', 'fticket'));
    for (const legacySkill of ['ftown-sessions', 'ftown-loops', 'ftown-orchestrator', 'ftown-workflows']) {
      removeFtownSkill(legacySkill);
    }

    const cliBundlePath = existsSync(resolve(__dirname, 'ftown-sessions-cli.js'))
      ? resolve(__dirname, 'ftown-sessions-cli.js')
      : resolve(__dirname, '..', 'dist', 'ftown-sessions-cli.js');
    const cliPath = installFtownSessionsCli(cliBundlePath);
    console.log(`[Bridge] Installed CLI at ${cliPath}`);

    const workflowsCliBundlePath = existsSync(resolve(__dirname, 'workflow-runner-cli.js'))
      ? resolve(__dirname, 'workflow-runner-cli.js')
      : resolve(__dirname, '..', 'dist', 'workflow-runner-cli.js');
    const workflowsCliPath = installFtownWorkflowsCli(workflowsCliBundlePath);
    console.log(`[Bridge] Installed workflows CLI at ${workflowsCliPath}`);

    const envCliBundlePath = existsSync(resolve(__dirname, 'ftown-env-cli.js'))
      ? resolve(__dirname, 'ftown-env-cli.js')
      : resolve(__dirname, '..', 'dist', 'ftown-env-cli.js');
    const envCliPath = installFtownEnvCli(envCliBundlePath);
    console.log(`[Bridge] Installed env CLI at ${envCliPath}`);

    const ftownCliBundlePath = existsSync(resolve(__dirname, 'ftown-cli.js'))
      ? resolve(__dirname, 'ftown-cli.js')
      : resolve(__dirname, '..', 'dist', 'ftown-cli.js');
    const ftownCommandPath = installFtownCommandCli(ftownCliBundlePath);
    console.log(`[Bridge] Installed ftown command at ${ftownCommandPath}`);

    const pathSetup = ensureFtownOnPath();
    if (pathSetup.skipped) {
      console.log('[Bridge] PATH setup skipped (FTOWN_SKIP_PATH_SETUP)');
    } else if (pathSetup.updated.length > 0) {
      console.log(`[Bridge] Added ~/.ftown to PATH in: ${pathSetup.updated.join(', ')}`);
    } else {
      console.log('[Bridge] PATH already includes ~/.ftown (no profiles changed)');
    }

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
          harness: harness?.wrapperPath,
          harnessCli: harness?.cliPath,
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
        publishRouter.publishTerminalScreen(sid, viewportRaw);
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
      publishRouter.publishTerminalScreen(sid, raw);
    }

    function handleClientResize(sid: string, cols: number, rows: number): void {
      runner.resize(sid, cols, rows);
      terminalManager.resize(sid, cols, rows);
    }

    localApiServer.on('event', (hookEvent: HookEvent) => {
      centrifugo.publishHookEvent(userId, hookEvent.sessionId, {
        type: 'hook_event',
        eventName: hookEvent.eventName,
        data: hookEvent.data,
      }).catch((err) => {
        console.error('[Bridge] Failed to handle hook event:', err);
      });

      pump.withSessionWrite(hookEvent.sessionId, () => agentIdPersister.persist(hookEvent)).catch((err) => {
        console.error(`[Bridge] Failed to persist agent session id for ${hookEvent.sessionId}:`, err);
      });
    });

    const handleCommand = createCommandHandler({
      bridgeId,
      sessionController,
      loopController,
      publishCommandResponse: (response) => centrifugo.publishCommandResponse(userId, response),
    });

    centrifugo.connect();
    centrifugo.joinBridgesChannel(userId, bridgeId);
    centrifugo.subscribeToSessions(userId);
    centrifugo.subscribeToLoops(userId);

    let ready = false;
    centrifugo.subscribeToCommands(userId, (command) => {
      if (!ready) return;
      handleCommand(command).catch((err) => {
        console.error(`[Bridge] Unhandled error in command handler:`, err);
      });
    }, (directCommand) => {
      publishRouter.handleCommand(directCommand);
    });
    setTimeout(() => {
      void (async () => {
        ready = true;
        console.log('[Bridge] Ready and listening for commands');
        try {
          await resurrection.resurrectSessions();
        } catch (err) {
          console.error('[Bridge] Session resurrection failed:', err);
        }
        // Loops start AFTER resurrection: skip missed fires, push the current loop
        // snapshot to the UI, then begin the 30s tick.
        try {
          await scheduler.reconcileOnStart();
          for (const loop of listLoops()) {
            await centrifugo.publishLoopUpdate(userId, loop).catch((err) => {
              console.error(`[Bridge] Failed to publish loop ${loop.id} on ready:`, err);
            });
          }
          scheduler.start();
          console.log(`[Bridge] Loop scheduler started (tick every ${LOOP_TICK_INTERVAL_MS}ms)`);
        } catch (err) {
          console.error('[Bridge] Loop scheduler failed to start:', err);
        }
      })();
    }, 2000);

    const shutdown = (): void => {
      console.log('\n[Bridge] Shutting down...');
      scheduler.stop();
      localApiServer.stop();
      runner.stopAll();
      loopbackServer.closeAll();
      directPeers.closeAll();
      watchRegistry.dispose();
      // node-datachannel module-level cleanup — avoids the native crash-on-exit race.
      try { ndcCleanup(); } catch { /* native lib already torn down */ }
      centrifugo.disconnect();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program.parse();
