#!/usr/bin/env node

import { Command as Commander } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { resolve, dirname, join } from 'node:path';
import { hostname as osHostname, networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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
import { installPiExtension } from './pi-extension-installer.js';
import { installOpencodePlugin, opencodeBinaryAvailable } from './opencode-plugin-installer.js';
import { installFtownSkill, removeFtownSkill } from './install-ftown-skill.js';
import { installFtownSessionsCli } from './install-ftown-cli.js';
import { installFtownWorkflowsCli } from './install-ftown-workflows-cli.js';
import { installFtownEnvCli } from './install-ftown-env-cli.js';
import { installFtownCommandCli } from './install-ftown-command-cli.js';
import { ensureFtownOnPath } from './ensure-ftown-path.js';
import { unregisterSession, configureSessionRegistryHome } from './session-registry.js';
import { createFtownSession, type CreateFtownSessionDeps } from './create-ftown-session.js';
import { createCommandHandler } from './command-rpc.js';
import { removeFtownSession } from './remove-ftown-session.js';
import { SessionResurrection } from './session-resurrection.js';
import { TerminalPump } from './terminal-pump.js';
import { collectSessionUsage } from './usage-collector.js';
import { AgentSessionIdPersister } from './session-ids.js';
import { HookUsagePersister } from './hook-usage.js';
import { fetchBridgeToken, refreshBridgeToken, type BridgeAuthResponse } from './bridge-auth.js';
import { RotatingTokenRefresher } from './rotating-token-refresher.js';
import { listLoops, configureLoopStoreHome } from './loop-store.js';
import { configureLoopRunStoreHome } from './loop-run-store.js';
import { resolveDefaultDataDir, resolveFtownHome } from './ftown-home.js';
import { LoopScheduler, LOOP_TICK_INTERVAL_MS } from './loop-scheduler.js';
import { LoopController } from './loop-controller.js';
import { SessionController } from './session-controller.js';
import { runPairing } from './pairing-client.js';
import { createServer } from 'node:http';
import { generateAccessKey, mintHubJwt, sha256Hex } from './solo/solo-auth.js';
import { DEFAULT_SOLO_PORT, SOLO_USER_ID, type SoloConfig } from './solo/contract.js';
import { ensureHubBinary, startHub, stopHub, writeHubConfig } from './solo/hub-manager.js';
import {
  ensurePanelBundle,
  findPanelServerDir,
  normalizePanelVersion,
  startPanel,
  stopPanel,
} from './solo/panel-manager.js';
import { createSoloServer } from './solo/solo-server.js';

/** Bridge package version — doubles as the default panel bundle version. */
const BRIDGE_VERSION = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
).version as string;

/** LAN IPv4 addresses for the solo banner (loopback excluded). */
function networkInterfacesForBanner(): string[] {
  const out: string[] = [];
  try {
    const nets = networkInterfaces();
    for (const list of Object.values(nets)) {
      for (const net of list ?? []) {
        if (net.family === 'IPv4' && !net.internal) out.push(net.address);
      }
    }
  } catch { /* best-effort banner */ }
  return out;
}

function isLoopbackOnly(ips: string[]): boolean {
  return ips.length === 0;
}

import type { HookEvent } from './local-api-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_API_URL = 'https://ftown.ia.br';

const program = new Commander();

program
  .name('ftown-bridge')
  .description('ftown orchestrator bridge for Centrifugo')
  .option('--solo', 'Single-port LAN deployment: no account service, managed hub + panel children, key-based auth')
  .option('--port <port>', 'Public port for --solo front (default: see DEFAULT_SOLO_PORT)')
  .option('--rotate-key', 'With --solo: regenerate the access key, print the new banner, exit (offline)')
  .option('--token <jwt>', 'Bridge bootstrap token from the ftown dashboard (short-lived; used once to onboard, then a rotating refresh token is stored). Optional: with no token and no stored refresh token, the bridge runs interactive device pairing instead.')
  .option('--api-url <url>', 'ftown UI API URL', DEFAULT_API_URL)
  .option('--data-dir <path>', 'Directory for session data (default: ~/.ftown/data)')
  .option('--bridge-id <id>', 'Bridge instance ID (default: persisted per data dir)')
  .action(async (opts: { solo?: boolean; port?: string; rotateKey?: boolean; token?: string; apiUrl: string; dataDir?: string; bridgeId?: string }) => {
    const apiUrl = new URL(opts.apiUrl);
    const isLocalHost =
      apiUrl.hostname === 'localhost' ||
      apiUrl.hostname === '127.0.0.1' ||
      apiUrl.hostname === '::1' ||
      apiUrl.hostname.endsWith('.localhost');
    if (apiUrl.protocol !== 'https:' && !isLocalHost && process.env.FTOWN_ALLOW_INSECURE_API !== '1') {
      program.error(
        `--api-url must use https:// for non-local hosts (${opts.apiUrl}). ` +
          'Bridge tokens would otherwise cross the network unencrypted. ' +
          'Set FTOWN_ALLOW_INSECURE_API=1 to override for trusted LAN setups.',
      );
    }

    // Resolve the default ONCE (it may perform a one-time legacy ./data
    // migration) and reuse it for both the data dir and the home resolution, so
    // the migration side effect never runs twice.
    const defaultDataDir = resolveDefaultDataDir();
    const dataDir = opts.dataDir ? resolve(opts.dataDir) : defaultDataDir;
    // Instance-scoped ".ftown home" for pointer + loop-state files. The DEFAULT
    // data dir resolves to $HOME/.ftown (unchanged — the harness CLIs hardcode
    // that path). A non-default --data-dir (Solo test, Docker, a second bridge)
    // gets its own home so it never touches the primary bridge's bridge.json,
    // loops.json, loop-runs.json or session-registry.json. Configure the store
    // singletons ONCE here, before any of them is read/written.
    const ftownHome = resolveFtownHome(dataDir, defaultDataDir);
    configureLoopStoreHome(ftownHome);
    configureLoopRunStoreHome(ftownHome);
    configureSessionRegistryHome(ftownHome);
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

    // L4: --rotate-key short-circuits BEFORE any listener binds (exit 0,
    // nothing started). Without --solo it is an argument error.
    if (opts.rotateKey && !opts.solo) {
      program.error('--rotate-key requires --solo');
    }
    if (opts.solo && opts.rotateKey) {
      const raw = generateAccessKey().raw;
      mkdirSync(join(dataDir, 'solo'), { recursive: true, mode: 0o700 });
      writeFileSync(join(dataDir, 'solo', 'access-key-hash'), `${sha256Hex(raw)}\n`, { mode: 0o600 });
      const port = opts.port ? Number(opts.port) : DEFAULT_SOLO_PORT;
      console.log('========================================');
      console.log('  ftown SOLO — access key rotated');
      for (const ip of networkInterfacesForBanner()) {
        console.log(`  Open:   http://${ip}:${port}/#k=${raw}`);
      }
      console.log('========================================');
      process.exit(0);
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

    // ----- SOLO MODE (contract: bridge/src/solo/contract.ts, lifecycle L1-L4) -----
    let solo: {
      config: SoloConfig;
      front: { port: number; close(): Promise<void> };
      hub: { stop(): void };
      panel: { stop(): void };
      hubReady: Promise<void>;
      panelReady: Promise<void>;
    } | undefined;

    if (opts.solo) {
      const hubSecretPath = join(dataDir, 'solo', 'hub-secret');
      let hubSecret: string;
      try {
        hubSecret = readFileSync(hubSecretPath, 'utf8').trim();
      } catch {
        hubSecret = randomBytes(32).toString('hex');
        mkdirSync(dirname(hubSecretPath), { recursive: true, mode: 0o700 });
        writeFileSync(hubSecretPath, `${hubSecret}\n`, { mode: 0o600 });
      }

      // Key lifecycle (S1/S11): raw key exists only in memory at generation and
      // in the one-time banner. Persisted state is the hash alone. Rotation is
      // handled by the L4 short-circuit above; here a missing hash means FIRST
      // boot — generate fresh so the banner can print the full link.
      const keyHashPath = join(dataDir, 'solo', 'access-key-hash');
      let accessKeyRaw: string | undefined;
      let accessKeyHash: string;
      try {
        accessKeyHash = readFileSync(keyHashPath, 'utf8').trim();
      } catch {
        accessKeyRaw = generateAccessKey().raw;
        accessKeyHash = sha256Hex(accessKeyRaw);
      }
      mkdirSync(join(dataDir, 'solo'), { recursive: true, mode: 0o700 });
      writeFileSync(keyHashPath, `${accessKeyHash}\n`, { mode: 0o600 });

      // Ephemeral private ports for children: probe free ports on loopback so
      // collisions are practically impossible (contract "Ports" block).
      const probeFreePort = (): Promise<number> =>
        new Promise((resolveP, rejectP) => {
          const srv = createServer();
          srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            if (!addr || typeof addr === 'string') {
              srv.close(() => rejectP(new Error('Failed to allocate child port')));
              return;
            }
            srv.close(() => resolveP(addr.port));
          });
          srv.on('error', rejectP);
        });
      const hubPort = await probeFreePort();
      const panelPort = await probeFreePort();

      const soloConfig: SoloConfig = {
        port: opts.port ? Number(opts.port) : DEFAULT_SOLO_PORT,
        hubPort,
        panelPort,
        dataDir,
        accessKeyHash,
        hubSecret,
      };

      const hubHealthy = { up: false };
      const panelHealthy = { up: false };

      const front = await createSoloServer({
        config: soloConfig,
        localApiPort: hookPort,
        hub: { isHealthy: () => hubHealthy.up },
        panel: { isHealthy: () => panelHealthy.up },
      });

      // Children ensured asynchronously AFTER the front listens (L1). The hub
      // must be healthy before the Centrifugo client connects — gated below.
      const soloDir = join(dataDir, 'solo');
      const hubReady = (async () => {
        const binPath = await ensureHubBinary({ dataDir });
        const configPath = join(soloDir, 'centrifugo.json');
        await writeHubConfig(configPath, { port: hubPort, secret: hubSecret });
        await startHub({ configPath, binPath, dataDir });
        hubHealthy.up = true;
        console.log('[Solo] Hub is up (private port)');
      })();
      hubReady.catch((err) => {
        console.error('[Solo] Hub failed to start:', err instanceof Error ? err.message : String(err));
      });

      // Panel version defaults to the bare bridge version (release-tag
      // parity — panelBundleUrl's template already supplies the `v` prefix
      // for the tag segment); override with FTOWN_SOLO_PANEL_VERSION for
      // development. Either source may be typed with a leading `v`, so both
      // are normalized to the bare semver panelBundleUrl expects.
      const panelVersion = normalizePanelVersion(
        process.env.FTOWN_SOLO_PANEL_VERSION ?? BRIDGE_VERSION,
      );
      const panelReady = (async () => {
        if (process.env.FTOWN_SOLO_PANEL_DIR) {
          // Dev escape hatch: serve an already-built standalone directory.
          const serverDir = await findPanelServerDir(resolve(process.env.FTOWN_SOLO_PANEL_DIR));
          console.log(`[Solo] Using local panel dir: ${serverDir}`);
          await startPanel({ bundleDir: serverDir, port: panelPort, dataDir });
        } else {
          const bundleDir = await ensurePanelBundle({ dataDir, version: panelVersion });
          const serverDir = await findPanelServerDir(bundleDir);
          await startPanel({ bundleDir: serverDir, port: panelPort, dataDir });
        }
        panelHealthy.up = true;
        console.log('[Solo] Panel is up (private port)');
      })();
      panelReady.catch((err) => {
        console.error('[Solo] Panel failed to start:', err instanceof Error ? err.message : String(err));
      });

      // One-time banner (S1 exception): full link ONLY when a fresh key was
      // generated; otherwise print keyless URL + rotation hint.
      const bannerIps = networkInterfacesForBanner();
      console.log('========================================');
      console.log('  ftown SOLO mode');
      console.log(`  Bridge ID: ${bridgeId}`);
      for (const ip of bannerIps) {
        const base = `http://${ip}:${front.port}`;
        if (accessKeyRaw) {
          console.log(`  Open:   ${base}/#k=${accessKeyRaw}`);
        } else {
          console.log(`  URL:    ${base}  (key already paired — --rotate-key reprints)`);
        }
      }
      if (!accessKeyRaw) {
        console.log('  Key not shown: already issued once. --rotate-key regenerates it.');
      }
      if (bannerIps.length === 0) {
        console.log('  WARNING: no LAN interface detected; loopback only.');
      } else {
        console.log('  WARNING: bound to a non-loopback interface over plain HTTP (S9).');
      }
      console.log('========================================');

      solo = {
        config: soloConfig,
        front,
        hub: {
          stop: () => {
            void stopHub(dataDir).catch(() => {});
          },
        },
        panel: {
          stop: () => {
            void stopPanel(dataDir).catch(() => {});
          },
        },
        hubReady,
        panelReady,
      };
    }
    // ----- END SOLO MODE -----

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
    if (solo) {
      // Solo mode: identity is synthesized locally (contract S2/S10). No
      // refresh token exists; getToken() mints a fresh hub JWT on demand.
      // The bridge's own connection token carries `info` (matching the cloud
      // minter's shape) so the panel's presence-based bridge list sees it —
      // browser tokens from /api/solo/bootstrap|token deliberately omit it.
      const token = mintHubJwt({
        secret: solo.config.hubSecret,
        info: { bridgeId, hostname: osHostname() },
      });
      auth = {
        userId: SOLO_USER_ID,
        token,
        refreshToken: '',
        centrifugoUrl: `ws://127.0.0.1:${solo.config.hubPort}/connection/websocket`,
      };
    } else if (persistedRefreshToken) {
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
    const currentRefreshToken = auth.refreshToken;
    if (!solo) persistRefreshToken(currentRefreshToken);

    const tokenRefresher = solo
      ? null
      : new RotatingTokenRefresher({
          initialRefreshToken: currentRefreshToken,
          refresh: (refreshToken) =>
            refreshBridgeToken(opts.apiUrl, refreshToken, bridgeId, local),
          loadPersistedRefreshToken: () => {
            try {
              return readFileSync(refreshTokenPath, 'utf8').trim() || undefined;
            } catch {
              return undefined;
            }
          },
          persistRefreshToken,
          onPersistedTokenRecovery: () => {
            console.warn(
              '[Bridge] In-memory refresh token was stale; retrying with the newer persisted token.',
            );
          },
        });

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
      if (solo) {
        // Solo: mint locally — no remote refresh, no refresh-token rotation.
        // Carries the same `info` claim as the initial mint above so the
        // panel keeps seeing this bridge across every refresh.
        return mintHubJwt({
          secret: solo.config.hubSecret,
          info: { bridgeId, hostname: osHostname() },
        });
      }
      console.log('[Bridge] Refreshing Centrifugo token...');
      const token = await tokenRefresher!.getToken();
      console.log('[Bridge] Token refreshed successfully');
      return token;
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
        // Re-publishing EVERY session on each reconnect is a publish storm that
        // (before the flapping fix) fed the command-echo backlog. Terminal
        // records (completed/error) don't change and were already in the UI's
        // list before the blip, so only live sessions need a re-push. Publish in
        // bounded batches with a macrotask yield between them so a large account
        // can't monopolize the event loop. A single publish's payload is
        // unchanged.
        const RESYNC_CHUNK = 10;
        const sessions = await store.listSessions();
        const live = sessions.filter(
          (session) => session.status === 'running' || session.status === 'pending',
        );
        for (let i = 0; i < live.length; i += RESYNC_CHUNK) {
          await Promise.all(
            live.slice(i, i + RESYNC_CHUNK).map((session) =>
              centrifugo.publishSessionUpdate(userId, session),
            ),
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const loops = listLoops();
        for (let i = 0; i < loops.length; i += RESYNC_CHUNK) {
          await Promise.all(
            loops.slice(i, i + RESYNC_CHUNK).map((loop) =>
              centrifugo.publishLoopUpdate(userId, loop),
            ),
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        console.log(
          `[Bridge] Re-synced ${live.length} session(s) and ${loops.length} loop(s) after Centrifugo reconnect`,
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
      // hasTmuxSession is the third arm: a session can be alive in tmux with no
      // PTY client in THIS process (agent-spawned re-run, adopted after a bridge
      // restart, resurrection deferred). Those used to fail the guard, so the
      // watch was dropped and every device rendered a blank pane. The tmux probe
      // is a subprocess, so it runs last — the two in-memory checks short-circuit
      // for every session this bridge already serves.
      isKnownSession: (sid) => runner.isRunning(sid) || terminalManager.has(sid) || runner.hasTmuxSession(sid),
    });

    // Accepting the watch is not enough on its own to make output flow.
    // publishScreenDump serves entirely from terminalManager, which is fed by
    // TerminalPump from runner 'data' events — there is no tmux capture-pane
    // path — so a session alive in tmux with no PTY client here dumps an empty
    // screen and then streams nothing. Attach one client through the SAME adopt
    // path session resurrection uses (runner.reattach); tmux redraws the full
    // screen to a joining client, so live output resumes within milliseconds and
    // rides the already-attached pump. No new pump, no new tmux plumbing.
    const watchReattachInFlight = new Set<string>();
    const ensureWatchedSessionAttached = (sid: string): void => {
      if (runner.isRunning(sid) || watchReattachInFlight.has(sid)) return;
      if (!runner.hasTmuxSession(sid)) return;
      watchReattachInFlight.add(sid);
      void store.loadSession(sid)
        .then((session) => {
          // Only adopt what this store still considers live: a tmux session with
          // no live record may belong to another bridge on this machine.
          if (!session || (session.status !== 'running' && session.status !== 'pending')) return;
          if (runner.isRunning(sid)) return;
          if (!runner.reattach(sid, {
            workingDir: session.workingDir,
            parentSessionId: session.parentSessionId,
          })) return;
          // Idempotent: subscribeToTerminalInput no-ops on an existing channel.
          wireTerminalInput(sid);
          console.log(`[Bridge] Reattached tmux session ${sid} for a new terminal watcher`);
        })
        .catch((err) => {
          console.error(`[Bridge] Failed to reattach ${sid} for a terminal watcher:`, err);
        })
        .finally(() => { watchReattachInFlight.delete(sid); });
    };

    // Every NEW remote watcher (first, each additional distinct client, or a
    // post-expiry re-registration) ⇒ push a full screen resync so the joining
    // Centrifugo-fallback client renders before incremental output (R1). The
    // dump is channel-wide; existing viewers re-render idempotently.
    watchRegistry.onNewWatcher((sid) => {
      ensureWatchedSessionAttached(sid);
      publishScreenDump(sid);
    });

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
    const bundledPiExtensionPath = resolve(__dirname, '..', 'pi-extension', 'ftown.js');
    const piExtensionPath = installPiExtension(bundledPiExtensionPath);
    installClaudeHooks(notifyScriptPath);
    installCursorHooks(notifyScriptPath);
    console.log(`[Bridge] Pi extension: ${piExtensionPath}`);
    // The opencode plugin rides opencode's global plugin dir; skip silently
    // when the opencode binary is not installed on this machine.
    if (await opencodeBinaryAvailable()) {
      const bundledOpencodePluginPath = resolve(__dirname, '..', 'opencode-plugin', 'ftown.js');
      const opencodePluginPath = installOpencodePlugin(bundledOpencodePluginPath);
      console.log(`[Bridge] opencode plugin: ${opencodePluginPath}`);
    }

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
    const hookUsagePersister = new HookUsagePersister({
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

    // Pointer lives under the instance home (see configure* above): default →
    // $HOME/.ftown (harness CLIs read it there), custom --data-dir → that dir.
    // Write and cleanup unlink MUST use this same resolved path.
    const bridgeStateDir = ftownHome;
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
      pump.withSessionWrite(hookEvent.sessionId, async () => {
        await agentIdPersister.persist(hookEvent);
        const usage = await hookUsagePersister.persist(hookEvent);
        await centrifugo.publishHookEvent(userId, hookEvent.sessionId, {
          type: 'hook_event',
          eventName: hookEvent.eventName,
          data: hookEvent.data,
          ...(usage ? { usage } : {}),
        });
      }).catch((err) => {
        console.error(`[Bridge] Failed to handle hook event for ${hookEvent.sessionId}:`, err);
      });
    });

    const handleCommand = createCommandHandler({
      bridgeId,
      sessionController,
      loopController,
      publishCommandResponse: (response) => centrifugo.publishCommandResponse(userId, response),
    });

    // Solo: the hub child must be healthy before connecting (L1 gates the
    // transport, not the front). A failed hub is fatal for solo — exit cleanly
    // instead of crashing on an unhandled rejection.
    if (solo) {
      try {
        await solo.hubReady;
        console.log('[Solo] Hub healthy — connecting Centrifugo client');
      } catch (err) {
        console.error('[Solo] Cannot continue without the hub:', err instanceof Error ? err.message : String(err));
        process.exit(1);
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
      // Solo L2 ordering: stop accepting first, then children (panel before
      // hub), then the rest of the bridge teardown.
      if (solo) {
        void solo.front.close().catch(() => {});
        solo.panel.stop();
        solo.hub.stop();
      }
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
