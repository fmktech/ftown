#!/usr/bin/env node

import { Command as Commander } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { resolve, dirname, join } from 'node:path';
import { homedir, hostname as osHostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
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
import { registerSessionWorkspace, unregisterSession } from './session-registry.js';
import { canResumeStoredSession, createFtownSession, findMissingProviderAuth, relaunchFtownSession, WorkingDirMissingError, type CreateFtownSessionDeps } from './create-ftown-session.js';
import { loadProviderEnv } from './provider-env-store.js';
import { removeFtownSession } from './remove-ftown-session.js';
import { shouldResurrectStoredSession } from './session-resurrection.js';
import { createLoop, deleteLoop, getLoop, listLoops, mutateLoopRuntime, updateLoop } from './loop-store.js';
import { deleteLoopRunRecords, listLoopRunRecordsWithFallback } from './loop-run-store.js';
import { LoopScheduler, LOOP_TICK_INTERVAL_MS } from './loop-scheduler.js';
import { validateLoopDraft, validateLoopPatch } from './loop-validation.js';
import { isTmuxAvailable, killTmuxSession, listFtownTmuxSessions } from './tmux.js';
import { runPairing } from './pairing-client.js';

import type { HookEvent } from './local-api-server.js';

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
  LoopDraft,
  RemoveSessionPayload,
  RenameSessionPayload,
  RunLoopNowPayload,
  UpdateLoopPayload,
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

async function fetchBridgeToken(
  apiUrl: string,
  authToken: string,
  bridgeId: string,
  local: { localPort: number; localNonce: string },
): Promise<BridgeAuthResponse> {
  const res = await fetch(`${apiUrl}/api/auth/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: authToken,
      bridgeId,
      hostname: osHostname(),
      // Embedded in the Centrifugo connection JWT `info` claim so the owning
      // user's clients discover the loopback WS rung via presence (L2).
      localPort: local.localPort,
      localNonce: local.localNonce,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bridge auth failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<BridgeAuthResponse>;
}

/**
 * Exchange a (rotating) refresh token for a fresh Centrifugo connect token.
 *
 * The server rotates the refresh token on every use (audit finding F3): the
 * response carries a NEW refreshToken that supersedes the one just sent, so the
 * caller must persist it and send the newest value next time. Reusing an old
 * refresh token is rejected.
 */
async function refreshBridgeToken(
  apiUrl: string,
  refreshToken: string,
  bridgeId: string,
  local: { localPort: number; localNonce: string },
): Promise<BridgeAuthResponse> {
  const res = await fetch(`${apiUrl}/api/auth/bridge/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refreshToken,
      bridgeId,
      hostname: osHostname(),
      localPort: local.localPort,
      localNonce: local.localNonce,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<BridgeAuthResponse>;
}

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
  .requiredOption('--api-url <url>', 'ftown UI API URL (e.g. https://ftown.vercel.app)')
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
      publishRouter.publishTerminalData(sessionId, buf);
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
    const agentIdCache = new Map<string, { claude?: string; cursor?: string; codex?: string; isCodex?: boolean }>();

    async function persistAgentSessionIds(hookEvent: HookEvent): Promise<void> {
      // Workspace-fallback attribution may come from a foreign agent the user
      // ran manually in the same directory; never persist its ids.
      if (hookEvent.source === 'workspace') return;

      const rawAgentId = hookEvent.data['session_id'];
      const rawCursorId = hookEvent.data['conversation_id'];
      // Claude Code AND Codex hooks carry session_id (which field it lands in
      // depends on the session's shellType); Cursor hooks carry conversation_id.
      const agentId = typeof rawAgentId === 'string' && rawAgentId ? rawAgentId : undefined;
      const cursorId = typeof rawCursorId === 'string' && rawCursorId ? rawCursorId : undefined;
      if (!agentId && !cursorId) return;

      const cached = agentIdCache.get(hookEvent.sessionId);
      if (cached
        && (!agentId || (cached.isCodex ? cached.codex === agentId : cached.claude === agentId))
        && (!cursorId || cached.cursor === cursorId)) {
        return;
      }

      const session = await store.loadSession(hookEvent.sessionId);
      if (!session) return;
      const isCodex = session.shellType === 'codex';

      let changed = false;
      if (agentId) {
        if (isCodex && session.codexSessionId !== agentId) {
          session.codexSessionId = agentId;
          changed = true;
        } else if (!isCodex && session.claudeSessionId !== agentId) {
          session.claudeSessionId = agentId;
          changed = true;
        }
      }
      if (cursorId && session.cursorSessionId !== cursorId) {
        session.cursorSessionId = cursorId;
        changed = true;
      }
      if (!changed) {
        agentIdCache.set(hookEvent.sessionId, {
          claude: session.claudeSessionId,
          cursor: session.cursorSessionId,
          codex: session.codexSessionId,
          isCodex,
        });
        return;
      }

      session.updatedAt = new Date().toISOString();
      await store.saveSession(session);
      // Cache only after a successful save, so a failed persist is retried.
      agentIdCache.set(hookEvent.sessionId, {
        claude: session.claudeSessionId,
        cursor: session.cursorSessionId,
        codex: session.codexSessionId,
        isCodex,
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
            response = { requestId: command.requestId, success: true, data: { sessions: sessions.map(toWireSession) } };
            break;
          }

          case 'get_history': {
            const payload = command.payload as GetHistoryPayload;
            if (!payload.sessionId) {
              response = { requestId: command.requestId, success: false, error: 'Missing sessionId' };
              break;
            }

            const session = await store.loadSession(payload.sessionId);
            response = { requestId: command.requestId, success: true, data: { session: session ? toWireSession(session) : session } };
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

            await relaunchFtownSession(sessionFactoryDeps, existingSession, 'retry');

            response = { requestId: command.requestId, success: true, data: { session: toWireSession(existingSession) } };
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

            response = { requestId: command.requestId, success: true, data: { session: toWireSession(target) } };
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

            response = { requestId: command.requestId, success: true, data: { session: toWireSession(sessionToRename) } };
            break;
          }

          case 'remove_session': {
            const payload = command.payload as RemoveSessionPayload;
            if (!payload.sessionId) {
              response = { requestId: command.requestId, success: false, error: 'Missing sessionId' };
              break;
            }

            const removed = await removeFtownSession(
              { store, runner, centrifugo, userId },
              payload.sessionId,
              { onlyIfFinished: payload.onlyIfFinished },
            );

            response = { requestId: command.requestId, success: true, data: { removed: removed !== null } };
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

          case 'create_loop': {
            const payload = command.payload as CreateLoopPayload;
            const error = validateLoopDraft(payload);
            if (error) {
              response = { requestId: command.requestId, success: false, error };
              break;
            }
            // bridgeId is forced to THIS bridge (the routing guard already proved
            // payload.bridgeId === bridgeId), so a loop is always owned by its runner.
            const draft: LoopDraft = {
              name: payload.name.trim(),
              bridgeId,
              schedule: payload.schedule,
              harness: payload.harness,
              workdir: payload.workdir,
              task: payload.task,
              model: payload.model,
              enabled: payload.enabled,
              overlapPolicy: payload.overlapPolicy,
              retention: payload.retention,
              preflight: payload.preflight,
              postflight: payload.postflight,
              maxRuntimeMs: payload.maxRuntimeMs,
              group: payload.group,
            };
            const loop = createLoop(draft);
            await centrifugo.publishLoopUpdate(userId, loop);
            response = { requestId: command.requestId, success: true, data: { loop } };
            break;
          }

          case 'list_loops': {
            response = { requestId: command.requestId, success: true, data: { loops: listLoops() } };
            break;
          }

          case 'update_loop': {
            const payload = command.payload as UpdateLoopPayload;
            if (!payload.loopId) {
              response = { requestId: command.requestId, success: false, error: 'Missing loopId' };
              break;
            }
            const patchError = validateLoopPatch(payload.patch);
            if (patchError) {
              response = { requestId: command.requestId, success: false, error: patchError };
              break;
            }
            const loop = updateLoop(payload.loopId, payload.patch);
            if (!loop) {
              response = { requestId: command.requestId, success: false, error: 'Loop not found' };
              break;
            }
            await centrifugo.publishLoopUpdate(userId, loop);
            response = { requestId: command.requestId, success: true, data: { loop } };
            break;
          }

          case 'delete_loop': {
            const payload = command.payload as DeleteLoopPayload;
            if (!payload.loopId) {
              response = { requestId: command.requestId, success: false, error: 'Missing loopId' };
              break;
            }
            const existingLoop = getLoop(payload.loopId);
            const removed = deleteLoop(payload.loopId);
            if (removed) {
              // Stop any in-flight run and drop scheduler tracking so a
              // just-deleted loop never leaves a live AI session with nothing
              // left to finalize/prune it.
              if (existingLoop) scheduler.onLoopDeleted(existingLoop);
              deleteLoopRunRecords(payload.loopId);
              await centrifugo.publishLoopRemoved(userId, payload.loopId);
            }
            response = { requestId: command.requestId, success: true, data: { removed } };
            break;
          }

          case 'run_loop_now': {
            const payload = command.payload as RunLoopNowPayload;
            if (!payload.loopId) {
              response = { requestId: command.requestId, success: false, error: 'Missing loopId' };
              break;
            }
            const loop = getLoop(payload.loopId);
            if (!loop) {
              response = { requestId: command.requestId, success: true, data: { fired: false, reason: 'not_found' } };
              break;
            }
            // A skip-policy loop with a live run cannot be manually fired either —
            // report overlap synchronously (the async tick would otherwise swallow it).
            if (
              loop.overlapPolicy === 'skip' &&
              loop.lastStatus === 'running' &&
              loop.lastSessionId &&
              runner.isRunning(loop.lastSessionId)
            ) {
              response = { requestId: command.requestId, success: true, data: { fired: false, reason: 'overlap' } };
              break;
            }
            // Reload-check-write via mutateLoopRuntime: if the loop was deleted
            // between the getLoop() above and this write, this returns null and
            // nothing is written/published — a stale in-memory snapshot must
            // never be upserted back, or a deleted loop resurrects.
            const updated = mutateLoopRuntime(payload.loopId, (l) => {
              l.runNowRequested = true;
              l.updatedAt = new Date().toISOString();
            });
            if (!updated) {
              response = { requestId: command.requestId, success: true, data: { fired: false, reason: 'not_found' } };
              break;
            }
            await centrifugo.publishLoopUpdate(userId, updated);
            scheduler.kick();
            response = { requestId: command.requestId, success: true, data: { fired: true } };
            break;
          }

          case 'get_loop_runs': {
            const payload = command.payload as GetLoopRunsPayload;
            if (!payload.loopId) {
              response = { requestId: command.requestId, success: false, error: 'Missing loopId' };
              break;
            }
            const sessions = (await store.listSessions()).map(toWireSession);
            const runs = await listLoopRunRecordsWithFallback(payload.loopId, sessions, (sessionId) =>
              store.loadTerminalLog(sessionId),
            );
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
        await centrifugo.publishCommandResponse(userId, response);
      } catch (err) {
        console.error(`[Bridge] Failed to publish command response:`, err);
      }
    }

    async function markSessionDead(session: Session, reason?: string): Promise<void> {
      session.status = 'error';
      session.errorReason = reason;
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
        session.errorReason = undefined;
        session.updatedAt = new Date().toISOString();
        await store.saveSession(session);
        await centrifugo.publishSessionUpdate(userId, session);
        wireTerminalInput(session.id);
        registerSessionWorkspace(session.id, session.workingDir);
        console.log(`[Bridge] Resurrected session ${session.id} via tmux reattach`);
        return;
      }

      if (canResumeStoredSession(session)) {
        const miss = findMissingProviderAuth(session.shellType, {
          processEnv: process.env,
          storeEnv: loadProviderEnv(),
        });
        if (miss) {
          await markSessionDead(session, miss.message);
          return;
        }
        // The custom-vs-rebuilt resume-command decision lives in
        // deriveRelaunchCommand, inside relaunchFtownSession.
        const resumeCommand = await relaunchFtownSession(sessionFactoryDeps, session, 'resume');
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
      // kills) before resurrection re-creates any. Archived tombstones count as
      // dead too: remove_session deletes the store record, so a failed tmux
      // kill would otherwise leave a permanently invisible live agent. Tmux
      // sessions with ids we have no record of are left alone — they may
      // belong to another bridge running on this machine.
      if (isTmuxAvailable()) {
        const archived = await store.listArchived();
        const deadIds = new Set([
          ...sessions
            .filter((s) => s.status !== 'running' && s.status !== 'pending')
            .map((s) => s.id),
          ...archived.map((a) => a.id),
        ]);
        // A live store record outranks any tombstone for the same id (crash
        // between archive and delete leaves both): never reap resurrectables.
        for (const s of sessions) {
          if (s.status === 'running' || s.status === 'pending') {
            deadIds.delete(s.id);
          }
        }
        for (const tmuxId of listFtownTmuxSessions()) {
          if (deadIds.has(tmuxId)) {
            console.log(`[Bridge] Killing tmux session for dead session ${tmuxId}`);
            await killTmuxSession(tmuxId);
          }
        }
      }

      let deferredLoopRuns = 0;
      for (const session of sessions) {
        if (session.loopId) {
          if (session.status !== 'running' && session.status !== 'pending') continue;
          deferredLoopRuns += 1;
          continue;
        }
        if (!shouldResurrectStoredSession(session)) continue;
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
      if (deferredLoopRuns > 0) {
        console.log(`[Bridge] Deferred ${deferredLoopRuns} loop-run session(s) to the loop scheduler`);
      }
    }

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
          await resurrectSessions();
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
