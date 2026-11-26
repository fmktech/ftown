#!/usr/bin/env node
import { deliverDiscussionMail, discussionSession } from './project-discussion-delivery.js';
import { TicketNotificationInbox, deliverTicketNotifications } from './ticket-notifications.js';

import { Command as Commander, CommanderError } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { resolve, dirname, join } from 'node:path';
import { hostname as osHostname, networkInterfaces, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, realpathSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { cleanup as ndcCleanup } from 'node-datachannel';
import { acquireBridgeInstance } from './bridge-instance.js';
import { configureUpdateOptions } from './update-options.js';

import { CentrifugoClient, type LedgerMessage } from './centrifugo-client.js';
import { WatchRegistry } from './direct-transport/watch-registry.js';
import { DirectPeerManager } from './direct-transport/peer-manager.js';
import { PublishRouter } from './direct-transport/publish-router.js';
import { LoopbackPeerServer } from './direct-transport/loopback-server.js';
import { toWireSession } from './session-wire.js';
import { ProcessRunner } from './claude-runner.js';
import { ProjectStorageMoves } from './project-storage-move.js';
import { ProjectBoardStore, sessionBlocksTicket, type ProjectBoard } from './project-board-store.js';
import { SessionStore } from './session-store.js';
import { MailStore } from './mail-store.js';
import { AttentionStore } from './attention-store.js';
import type { AttentionItem } from './attention-events.js';
import { PreviewChatStore } from './preview-chat.js';
import { BridgePushNotifier } from './push-notifier.js';
import { LocalApiServer } from './local-api-server.js';
import { parsePeerSessions, startPeerSessionCache, startPeerProjectDirectory } from './peer-session-cache.js';
import { hostResourceSampler } from './host-resources.js';
import { hasPendingChild, parseRemoteParent, sessionRequestPrincipal, SessionHierarchyWrites } from './session-parent.js';
import { remoteChildPlanStore, remotePlanBlocksHandoff } from './remote-child-plan.js';
import { PeerControl } from './peer-control.js';
import { PeerLinks } from './peer-link.js';
import { launchCapabilities, probeLaunchCapabilities } from './harness-registry.js';
import { startAddressedListener, type AddressedSetup } from './direct-transport/addressed-setup.js';
import { executeSecurePacket } from './security/bridge/execute.js';
import { BrowserAccess } from './browser-access.js';
import { registerLocalBrowserCommands } from './local-pair-cli.js';
import type { CommandResponse, Session } from './types.js';
import { TerminalManager } from './terminal-manager.js';
import { assertSetupReady } from './setup-state.js';
import { canonicalNotifyPath } from './install-notify-script.js';
import { unregisterSession, configureSessionRegistryHome } from './session-registry.js';
import { createFtownSession, type CreateFtownSessionDeps } from './create-ftown-session.js';
import { loadOrCreateIdentity, readBoundBridgeIdentity } from './security/bridge/identity.js';
import { bindLedgerIdentity } from './security/bridge/ledger-identity.js';
import { BridgeSecurityService, applicationJson } from './security/bridge/security.js';
import { BridgeStartingError } from './security/bridge/errors.js';
import type { ApplicationJson, EndpointIdentity, VerifiedApplication } from './security/protocol.js';
import { createCommandHandler } from './command-rpc.js';
import { createRealModelRoutingService } from './quota/routing-service.js';
import { PullRequestStatusService } from './pull-request-status.js';
import { createPrReviewService } from './pull-request-review.js';
import { PullRequestEventWatcher } from './pull-request-events.js';
import { createSessionBoardPublisher, liveSessionBoardRoots, type SessionBoardSource } from './session-board-snapshot.js';
import { PeerTeamOutbox } from './coordination/peer-team.js';
import { createCoordination } from './coordination/wiring.js';
import { removeFtownSession } from './remove-ftown-session.js';
import { SessionResurrection, shouldResurrectStoredSession } from './session-resurrection.js';
import { createTerminalOutput } from './terminal-output.js';
import { SessionFailureMonitor } from './session-block.js';
import { handoffSession, waitForSessionHealthy, type HandoffRequest } from './session-handoff.js';
import { hasTmuxSession, listFtownTmuxSessions, killTmuxSession } from './tmux.js';
import { collectSessionUsage } from './usage-collector.js';
import { AgentSessionIdPersister } from './session-ids.js';
import { HookUsagePersister } from './hook-usage.js';
import { createRevokedRestart } from './revoked-restart.js';
import { bridgeMode, canReexecAfterRevocation } from './revocation-gating.js';
import { createEndpointRegistrar, heldHistoryNotice, resetIdentityForStart, startAccountIdentity, startRelay, usesLedger, type EndpointRegistrar } from './ledger-startup.js';
import { createAccountRelay, createLedgerServer, readSavedRelayUrl, registerBridgeEndpoint, saveRelayUrl, subscribeApprovalRequired,
  type AccountRelay } from './ledger-relay.js';
import { runLedgerPairing } from './ledger-pairing-client.js';
import { resolveDefaultDataDir, resolveFtownHome } from './ftown-home.js';
import { SessionController } from './session-controller.js';
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
import { executeCli, isCliEntry } from './cli-entry.js';
import { UpdateAdmission } from './update-admission.js';
import { UpdateEffects } from './update-effects.js';
import { BridgeUpdateCoordinator } from './bridge-update.js';
import { resolveStableRelease, prepareRelease, discardPreparedRelease } from './update-release.js';
import { assertUpdateReservationAllowed, readUpdateRestartContext, reportUpdateReady, reserveUpdate,
  prepareHandoff, readUpdateReceipt, writeUpdateReceipt } from './update-handoff.js';
import type { UpdateRestartContext } from './update-runtime-contract.js';
import { detectWsl2, soloBannerLines, type Wsl2Probe } from './wsl2.js';

/** Bridge package version — doubles as the default panel bundle version. */
const BRIDGE_VERSION = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
).version as string;

/** Open attention items for one session, any route. Pages until the ledger is exhausted. */
async function openBoardAttention(store: AttentionStore, sessionId: string): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await store.list(sessionId, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit: 100,
      includeResolved: false,
    });
    items.push(...result.events);
    if (!result.hasMore || result.cursor === cursor) break;
    cursor = result.cursor;
  }
  return items;
}

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

/** Update restart must not admit work until the helper's final private acknowledgement. */
export async function finishUpdateRestartAdmission(admission: UpdateAdmission, reportReady: () => Promise<void>): Promise<void> {
  await reportReady();
  admission.reopen();
}

/** Runtime dependencies of the bridge entry point, injectable for unit tests. */
export interface RunBridgeDeps {
  /** Override the WSL2 probe (defaults to reading the kernel release files). */
  isWsl2?: Wsl2Probe;
}

export async function runBridge(argv: string[], commandName = 'ftown-bridge', deps: RunBridgeDeps = {}): Promise<number> {
const isWsl2 = deps.isWsl2 ?? detectWsl2;
const program = new Commander();
program.exitOverride();
configureUpdateOptions(program);

program
  .name(commandName)
  .description('ftown orchestrator bridge for Centrifugo')
  .option('--local', 'Local browser control only: no cloud account or connection')
  .option('--solo', 'Single-port LAN deployment: no account service, managed hub + panel children, key-based auth')
  .option('--port <port>', 'Public port for --solo front (default: see DEFAULT_SOLO_PORT)')
  .option('--rotate-key', 'With --solo: regenerate the access key, print the new banner, exit (offline)')
  .option('--api-url <url>', 'ftown UI API URL', DEFAULT_API_URL)
  .option('--data-dir <path>', 'Directory for session data (default: ~/.ftown/data)')
  .option('--bridge-id <id>', 'Bridge instance ID (default: persisted per data dir)')
  .option('--new-identity', 'Forget this computer’s account identity, then pair it again as a new computer with a passkey link (sessions are kept)')
  .action(async (opts: { allowUpdates?: boolean; local?: boolean; solo?: boolean; port?: string; rotateKey?: boolean; apiUrl: string; dataDir?: string; bridgeId?: string; newIdentity?: boolean }) => {
    if (opts.local && opts.solo) program.error('--local and --solo cannot be combined');
    if ((opts.local || opts.solo) && opts.newIdentity) program.error('--new-identity requires cloud mode');
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

    // Explicit setup must finish before any migration, identity, network or auth side effect.
    assertSetupReady(BRIDGE_VERSION);

    // Read-only default resolution; explicit setup owns legacy data migration.
    const defaultDataDir = resolveDefaultDataDir();
    const dataDir = opts.dataDir ? resolve(opts.dataDir) : defaultDataDir;
    // No bridge starts, and no identity is reset, while an update holds the reservation.
    assertUpdateReservationAllowed(homedir());
    if (!opts.rotateKey) {
      const instance = await acquireBridgeInstance(dataDir);
      // Hold ownership through teardown, including partial startup failures. The update
      // helper starts its successor only after this process exits.
      process.once('exit', () => instance.close());
    }
    const runMode = bridgeMode(opts);
    // Restart context is authenticated by the private helper channel before any mutation. It is read before any reset because a
    // helper-started bridge has no visible terminal: it must never print a pairing link (an invalid context matters only below).
    let launchContext: UpdateRestartContext | null = null;
    let launchContextError: unknown = null;
    try { launchContext = readUpdateRestartContext(); } catch (err) { launchContextError = err; }
    const launchedByUpdate = launchContext !== null || launchContextError !== null;
    // Account mode: --new-identity or v1 account state starts a reset. Every mode finishes one a revoked restart or a crash left pending.
    const resetOutcome = resetIdentityForStart({ dataDir, mode: runMode, newIdentity: Boolean(opts.newIdentity), updateRestart: launchedByUpdate,
      log: line => console.log(line) });
    if (resetOutcome.kind === 'exit') {
      console.log(resetOutcome.message);
      return process.exit(1);
    }
    const identityReset = resetOutcome.reset;
    let updateRestart: UpdateRestartContext | null = null;
    if (identityReset) {
      console.log(`[Bridge] New identity for this computer: ${identityReset.oldBridgeId ?? 'unknown'} -> ${identityReset.newBridgeId}`);
      if (opts.bridgeId !== undefined) {
        console.warn('[Bridge] Ignoring --bridge-id: this computer has a new identity.');
        opts.bridgeId = undefined;
      }
      // A reset bridge is a fresh install; an update context names the identity it just discarded.
      if (launchContextError !== null) {
        console.warn('[Bridge] Ignoring an invalid update restart context after the identity reset:',
          launchContextError instanceof Error ? launchContextError.message : String(launchContextError));
      } else if (launchContext) console.warn('[Bridge] Ignoring the update restart context: this computer has a new identity.');
    } else {
      if (launchContextError !== null) throw launchContextError;
      updateRestart = launchContext;
      if (updateRestart && (updateRestart.targetVersion !== BRIDGE_VERSION || opts.solo))
        throw new Error('Invalid update restart context');
    }
    // Every child/local CLI must resolve this exact instance, including custom --data-dir bridges.
    process.env.FTOWN_DATA_DIR = dataDir;
    // Instance-scoped ".ftown home" for pointer and registry files. The DEFAULT
    // data dir resolves to $HOME/.ftown (unchanged — the harness CLIs hardcode
    // that path). A non-default --data-dir (Solo test, Docker, a second bridge)
    // gets its own home so it never touches the primary bridge's bridge.json,
    // or session-registry.json. Configure the store
    // singletons ONCE here, before any of them is read/written.
    const ftownHome = resolveFtownHome(dataDir, defaultDataDir);
    process.env.FTOWN_BRIDGE_POINTER = join(ftownHome, 'bridge.json');
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
    if (updateRestart && (realpathSync(dataDir) !== realpathSync(defaultDataDir) || !persistedBridgeId || persistedBridgeId !== updateRestart.bridgeId ||
      (opts.bridgeId && opts.bridgeId !== updateRestart.bridgeId))) throw new Error('Update restart identity mismatch');
    const bridgeId = opts.bridgeId ?? persistedBridgeId ?? uuidv4();
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      // Tighten a pre-existing dir created before the explicit mode (fresh
      // installs would otherwise inherit the process umask, often 0755).
      chmodSync(dataDir, 0o700);
      writeFileSync(bridgeIdPath, `${bridgeId}\n`, { mode: 0o600 });
    } catch (err) {
      console.error('[Bridge] Failed to persist bridge id:', err instanceof Error ? err.message : String(err));
    }

    // Signed revocation of this bridgeId restarts the process as a fresh install, at most once.
    // The re-exec keeps this PID, so whatever startup has acquired so far is released first.
    let releaseForRestart: () => Promise<void> = async () => {};
    // Mirrors the update coordinator's receipts; an active operation holds the reservation under this PID.
    let updatePhase: string | null = null;
    const revokedRestart = createRevokedRestart({
      dataDir, scriptPath: process.argv[1], argv: process.argv.slice(2),
      shutdown: () => releaseForRestart(), log: message => console.log(message), exit: code => process.exit(code),
      canReexec: () => canReexecAfterRevocation({ updateRestart: updateRestart !== null, updatePhase }),
    });

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
      for (const line of soloBannerLines({
        ips: networkInterfacesForBanner(), port, accessKeyRaw: raw, isWsl2: isWsl2(),
      })) {
        console.log(line);
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
    // Reuse the local port so remembered browsers survive restarts. If another
    // process took it, the server chooses an available port and pair prints it.
    const localPortPath = join(dataDir, 'local-api-port');
    let preferredLocalPort = 0;
    try {
      const saved = Number(readFileSync(localPortPath, 'utf8').trim());
      if (Number.isInteger(saved) && saved > 0 && saved <= 65535) preferredLocalPort = saved;
    } catch { /* first start */ }
    if (updateRestart && !preferredLocalPort) throw new Error('Update restart endpoint is missing');
    const hookPort = await localApiServer.start(preferredLocalPort);
    if (updateRestart && hookPort !== preferredLocalPort) { localApiServer.stop(); throw new Error('Update restart endpoint is unavailable'); }
    releaseForRestart = async () => { localApiServer.stop(); };
    writeFileSync(localPortPath, `${hookPort}\n`, { mode: 0o600 });
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
      // generated; otherwise print keyless URL + rotation hint. Under WSL2 the
      // VM IP is not reachable from the LAN, so soloBannerLines points users at
      // localhost instead and documents port forwarding.
      const bannerIps = networkInterfacesForBanner();
      const wsl2 = isWsl2();
      console.log('========================================');
      console.log('  ftown SOLO mode');
      console.log(`  Bridge ID: ${bridgeId}`);
      for (const line of soloBannerLines({
        ips: bannerIps, port: front.port, accessKeyRaw, isWsl2: wsl2,
      })) {
        console.log(line);
      }
      if (wsl2) {
        console.log('  WARNING: WSL2 VM address is not reachable from the LAN — use localhost (see above).');
      } else if (bannerIps.length === 0) {
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

    const browserOrigin = new URL(opts.apiUrl).origin;
    const localOrigin = `http://127.0.0.1:${hookPort}`;
    /** Account startup failures end the process (the local API server would otherwise keep it alive). */
    const fail = (message: string | null): never => {
      if (message) console.error(message);
      return process.exit(1);
    };
    /** The relay identity of this bridge: account mode uses the accountId (relay JWT `sub`), never an email. */
    let auth: { ownerId: string; userId: string; token: string; centrifugoUrl: string };
    let security: BridgeSecurityService;
    let accountRelay: AccountRelay | undefined;
    let accountRegistrar: EndpointRegistrar | undefined;
    /** Bound once the relay client exists: a relay refused earlier reconnects when the key is accepted again. */
    let reconnectRelay = (): void => {};

    if (!usesLedger(runMode)) {
      // Solo and --local: identity is synthesized locally (contract S2/S10); no account, no ledger, no relay token by proof.
      const boundAtStartup = await readBoundBridgeIdentity(dataDir);
      if (updateRestart && (!boundAtStartup || boundAtStartup.identity.endpoint.id !== updateRestart.endpointId ||
        boundAtStartup.identity.endpoint.ownerId !== updateRestart.ownerId))
        throw new Error('Update restart identity is unavailable');
      if (opts.local) {
        auth = { ownerId: `solo:${bridgeId}`, userId: 'local', token: '', centrifugoUrl: 'ws://127.0.0.1/disabled' };
      } else {
        // getToken() mints a fresh hub JWT on demand. The bridge's own connection token carries `info` (matching the cloud
        // minter's shape) so the panel's presence-based bridge list sees it — browser tokens from /api/solo/bootstrap|token
        // deliberately omit it.
        const soloRuntime = solo!;
        auth = {
          ownerId: `solo:${bridgeId}`,
          userId: SOLO_USER_ID,
          token: mintHubJwt({ secret: soloRuntime.config.hubSecret, info: { bridgeId, hostname: osHostname() } }),
          centrifugoUrl: `ws://127.0.0.1:${soloRuntime.config.hubPort}/connection/websocket`,
        };
      }
      if (boundAtStartup && boundAtStartup.identity.endpoint.ownerId !== auth.ownerId) throw new Error('wrong_context');
      const identity: EndpointIdentity = boundAtStartup?.identity ?? await loadOrCreateIdentity(dataDir, auth.ownerId, 'bridge');
      if (identity.endpoint.ownerId !== auth.ownerId) throw new Error('wrong_context');
      const localIdentity = await loadOrCreateIdentity(dataDir, auth.ownerId, 'local-cli');
      const localSecurity = new BridgeSecurityService(identity, bridgeId, dataDir, { relayUserId: auth.userId, relayUrl: auth.centrifugoUrl, browserOrigin, localOrigin });
      security = localSecurity;
      releaseForRestart = async () => { localApiServer.stop(); await localSecurity.close(); };
      await localSecurity.policy.provisionLocalEndpoint(localIdentity.endpoint);
    } else {
      // ----- ACCOUNT MODE: the passkey ledger (CONTRACT C5) -----
      const server = createLedgerServer({ apiUrl: opts.apiUrl });
      // Steps 3-4: pair when unpaired, recover the replica when needed, then this bridge's own status, before any network identity use.
      const startup = await startAccountIdentity({
        // A helper-started bridge (even one whose context a reset discarded) has no terminal for the pairing link.
        dataDir, bridgeId, allowPairing: !launchedByUpdate,
        pair: (keys, store) => runLedgerPairing({ apiUrl: opts.apiUrl, dataDir, bridgeId, label: osHostname(), identity: keys, store,
          bindIdentity: accountId => bindLedgerIdentity(dataDir, accountId), print: line => console.log(line) }),
        fetchLedger: accountId => server.fetchLedger(accountId),
      });
      if (startup.kind === 'revoked') { await revokedRestart(); return; }
      if (startup.kind === 'exit') return fail(startup.message);
      const bound = startup.identity;
      if (updateRestart && (bound.endpoint.id !== updateRestart.endpointId || bound.accountId !== updateRestart.ownerId))
        throw new Error('Update restart identity is unavailable');
      const localIdentity = await loadOrCreateIdentity(dataDir, bound.accountId, 'local-cli');
      const ledgerSecurity = new BridgeSecurityService({ endpoint: bound.endpoint, keyPair: bound.keyPair }, bridgeId, dataDir, {
        relayUserId: bound.accountId, browserOrigin, localOrigin,
        ledger: { store: startup.store, bridgeId, authPublicKey: bound.authPublicKey, fetchLedger: () => server.fetchLedger(bound.accountId) },
      });
      security = ledgerSecurity;
      releaseForRestart = async () => { localApiServer.stop(); await ledgerSecurity.close(); };
      // Subscribed before startLedger: its read may prove the revocation.
      let bridgeRevoked = false;
      ledgerSecurity.onBridgeRevoked(() => { bridgeRevoked = true; void revokedRestart(); });
      await ledgerSecurity.policy.provisionLocalEndpoint(localIdentity.endpoint);
      await ledgerSecurity.startLedger();
      if (bridgeRevoked) { await revokedRestart(); return; }

      const relay = createAccountRelay({
        apiUrl: opts.apiUrl, accountId: bound.accountId, bridgeId, authPrivateKey: bound.authPrivateKey, security: ledgerSecurity,
        store: startup.store, server, hostname: () => osHostname(), localPort: () => hookPort,
        relayUrlOverride: process.env.FTOWN_CENTRIFUGO_URL,
        // The last relay URL the server named lets a later start come up while the server is unreachable.
        savedRelayUrl: readSavedRelayUrl(dataDir, opts.apiUrl), onRelayUrl: url => saveRelayUrl(dataDir, url),
        reconnect: () => reconnectRelay(),
      });
      accountRelay = relay;
      releaseForRestart = async () => {
        await localApiServer.closeTransfers();
        relay.stop();
        localApiServer.stop();
        await ledgerSecurity.close();
      };
      // A browser that enrolled moments ago may not be in this replica yet: its refused request pulls the server ledger (rate-limited),
      // so the browser's retry succeeds without waiting for the relay.
      if (!subscribeApprovalRequired(ledgerSecurity, () => relay.onUnknownEndpoint())) {
        console.warn('[Bridge] This security service has no approval-required signal; new browsers wait for the relay ledger update.');
      }
      // Only this bridge's own ledger endpoint is published, authenticated by its relay token.
      // An active member of its own history may hold the only copy of it: a refusal never makes it exit or advise a reset.
      const holdsHistory = (): boolean => !bridgeRevoked && ledgerSecurity.ledgerStatus().own === 'active';
      const registrar = createEndpointRegistrar({
        register: token => registerBridgeEndpoint({ apiUrl: opts.apiUrl, token, endpoint: bound.endpoint, bridgeId, label: osHostname() }),
        tokens: relay.tokens, bridgeRevoked: () => bridgeRevoked, held: holdsHistory, log: line => console.warn(line),
      });
      accountRegistrar = registrar;
      // Step 5: a refusal of a computer that holds its own history starts offline (with the held-history notice); any other refusal exits;
      // a temporary failure starts offline (local API, sessions) and keeps retrying in the background.
      const relayStart = await startRelay({ getToken: () => relay.tokens.getToken(), relayUrl: () => relay.relayUrl(),
        bridgeRevoked: () => bridgeRevoked, apiUrl: opts.apiUrl, held: () => holdsHistory() ? heldHistoryNotice(ledgerSecurity.uniqueHistory()) : null });
      if (relayStart.kind === 'revoked') { await revokedRestart(); return; }
      if (relayStart.kind === 'exit') return fail(relayStart.message);
      if (relayStart.kind === 'online') {
        const registration = await registrar.registerNow(relayStart.token);
        if (registration.kind === 'revoked') { await revokedRestart(); return; }
        if (registration.kind === 'exit') return fail(registration.message);
        if (registration.kind === 'retry') registrar.retryInBackground();
      } else {
        if (relayStart.notice) for (const line of relayStart.notice) console.warn(line);
        else console.warn(`[Bridge] Could not reach the ftown server (${relayStart.reason}). Starting offline with the last relay URL; reconnecting in the background.`);
        registrar.retryInBackground();
      }
      auth = { ownerId: bound.accountId, userId: bound.accountId, token: relayStart.kind === 'online' ? relayStart.token : '',
        centrifugoUrl: relayStart.relayUrl };
    }
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
      // --local never connects, so it never asks.
      if (!accountRelay) throw new Error('No relay in --local mode');
      // centrifuge-js polls every 5-10 s during a cooldown; stay quiet then. A key_revoked answer is evidence for the security
      // service (relay token hooks); only a verified revocation restarts this bridge.
      const quiet = accountRelay.tokens.cooldownRemainingMs() > 0;
      try {
        return await accountRelay.connectionToken();
      } catch (err) {
        if (!quiet) console.warn('[Bridge] Relay token unavailable:', err instanceof Error ? err.message : String(err));
        throw err;
      }
    }

    const store = new SessionStore(dataDir);
    // Migrate pre-existing session.json/terminal.log/inbox.jsonl off 0644.
    void store.hardenPermissions();
    // Sessions left in a live state by a previous bridge are handled by
    // resurrectSessions() once Centrifugo is connected (tmux reattach,
    // resume respawn, or marked as error).

    const terminalManager = new TerminalManager(50000, 120);

    const runner = new ProcessRunner();
    const updateAdmission = new UpdateAdmission();
    if (updateRestart) updateAdmission.freeze();
    const updateEffects = new UpdateEffects(updateAdmission);
    let resurrectionComplete = false;
    // Reconnect and coordination callbacks may run while later services are
    // bootstrapping. Keep their roots until the shared snapshot source is ready.
    let boardPublisher: ReturnType<typeof createSessionBoardPublisher> | undefined;
    const bootstrapBoardRoots = new Set<string>();
    const scheduleBoard = (rootId: string): void => {
      if (boardPublisher) boardPublisher.schedule(rootId);
      else bootstrapBoardRoots.add(rootId);
    };
    // Account mode only: the ledger channel's records and (re)subscriptions feed the replica.
    const ledgerRelay = accountRelay;
    const ledgerOptions = ledgerRelay ? {
      onLedgerMessage: (message: LedgerMessage) => ledgerRelay.onLedgerMessage(message),
      onLedgerSubscribed: () => ledgerRelay.onLedgerSubscribed(),
    } : {};
    const centrifugo = new CentrifugoClient(centrifugoUrl, auth.token, getToken, {
      ...ledgerOptions,
      disabled: opts.local,
      isSessionRetired: id => store.isRetired(id),
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
        const sessions = (await store.listSessions()).filter(session => session.bridgeId === bridgeId);
        const roots = liveSessionBoardRoots(sessions, bridgeId);
        if (boardPublisher) boardPublisher.reconcile(roots);
        else for (const rootId of roots) bootstrapBoardRoots.add(rootId);
        // The browser can remain connected while this bridge is offline, so
        // its own channel recovery cannot reveal mutations the bridge never
        // published. Tell it to reconcile the authoritative session list.
        await centrifugo.publishSessionSnapshotRequired(userId, bridgeId);
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
        console.log(
          `[Bridge] Re-synced ${live.length} session(s) after Centrifugo reconnect`,
        );
      },
    });
    centrifugo.setSecurity(security);
    // After a refusal centrifuge-js stops for good; the relay reconnects it once the key is accepted or a ledger is adopted.
    if (ledgerRelay) reconnectRelay = () => centrifugo.connect();
    if (ledgerRelay) ledgerRelay.setLedgerPublisher(announcement => centrifugo.publishLedgerAnnouncement(userId, announcement));
    centrifugo.onLocalPublication((channel, data) => localApiServer.recordPublication(channel, data));
    // Direct transport (WebRTC DataChannel) data plane. Peers attach per session;
    // terminal output/screen fan out to them directly, and to Centrifugo only when
    // the session has an unexpired remote watcher (R2). Signaling and watch
    // heartbeats ride the existing commands:rpc channel.
    // Dashboard commands arriving on a direct browser channel run through the same secure dispatch as the relay's.
    const serveDirectCommand = async (message: VerifiedApplication): Promise<ApplicationJson> => {
      if (!ready) throw new BridgeStartingError();
      return localApiServer.dispatchSecure(message);
    };
    const watchRegistry = new WatchRegistry();
    const directPeers = new DirectPeerManager({
      security,
      bridgeId,
      sendSignal: (msg) => {
        centrifugo.publishSignal(userId, msg).catch((err) => {
          console.error('[Bridge] Failed to publish WebRTC signal:', err);
        });
      },
      onInput: (sid, data) => { runner.write(sid, data); },
      onResize: (sid, cols, rows) => { handleClientResize(sid, cols, rows); },
      onAttach: attachDirectScreen,
      onCommand: { dispatch: message => serveDirectCommand(message), get observer() { return updateEffects; } },
    });
    // Loopback WebSocket rung: same DirectMessage protocol as WebRTC, tunneled
    // over TCP on the existing 127.0.0.1 local API server. Bypasses VPN/endpoint
    // filters that kill UDP hairpin. Input/resize/attach feed the SAME sinks as
    // the WebRTC peer manager; upgrades are gated on the per-process nonce (L1/L2).
    let browserAccess: BrowserAccess | undefined;
    let apiOrigin = '';
    try { apiOrigin = new URL(opts.apiUrl).origin; } catch { /* leave empty; only localhost origins accepted */ }
    const loopbackServer = new LoopbackPeerServer({
      security,
      bridgeId,
      nonce: localNonce,
      authorize: (token, origin) => browserAccess?.authorize(token, origin) ?? false,
      allowedOrigins: apiOrigin ? [apiOrigin] : [],
      onInput: (sid, data) => { runner.write(sid, data); },
      onResize: (sid, cols, rows) => { handleClientResize(sid, cols, rows); },
      onAttach: attachDirectScreen,
      onCommand: { dispatch: message => serveDirectCommand(message), get observer() { return updateEffects; } },
    });
    // Fixed-address rung: a browser that remembers this bridge's address, port and certificate connects with no signaling at
    // all, so a bridge on the same network or VPN stays reachable without the relay. Connections land in the same peer manager,
    // where the encrypted hello decides what they may do. FTOWN_DIRECT_ADDRESS=0 turns the listener off.
    let addressed: AddressedSetup | null = null;
    if (process.env.FTOWN_DIRECT_ADDRESS !== '0') {
      try {
        addressed = await startAddressedListener(dataDir, (pc, channel, pairId) => directPeers.adoptAddressed(pc, channel, pairId));
        console.log(`[Bridge] Direct address listener on UDP port ${addressed.listener.port}`);
      } catch (err) {
        console.warn('[Bridge] Direct address listener unavailable:', err instanceof Error ? err.message : String(err));
      }
    }
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
    const watchReattachInFlight = new Map<string, Promise<void>>();
    const ensureWatchedSessionAttached = (sid: string): Promise<void> | undefined => {
      if (runner.isRunning(sid)) return;
      const pending = watchReattachInFlight.get(sid);
      if (pending) return pending;
      if (!runner.hasTmuxSession(sid)) return;
      let release: () => void;
      try { release = updateAdmission.enter(); } catch { return; }
      const reattach = store.loadSession(sid)
        .then((session) => {
          // Only adopt what this store still considers live: a tmux session with
          // no live record may belong to another bridge on this machine.
          if (!session || !shouldResurrectStoredSession(session)) return;
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
        .finally(() => { watchReattachInFlight.delete(sid); release(); });
      watchReattachInFlight.set(sid, reattach);
      return reattach;
    };

    function attachDirectScreen(sid: string, deliver: (screen: string) => void): void {
      const reattach = ensureWatchedSessionAttached(sid);
      if (reattach) void reattach.then(() => terminalOutput.attachScreen(sid, deliver));
      else terminalOutput.attachScreen(sid, deliver);
    }

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
    // Push events authenticate with the relay token (Bearer), reused until it nears expiry.
    const pushNotifier = !ledgerRelay ? undefined : new BridgePushNotifier({
      apiUrl: opts.apiUrl,
      bridgeId,
      getToken: () => ledgerRelay.tokens.getToken(),
      getSession: (sessionId) => store.loadSession(sessionId),
    });
    const attentionStore = new AttentionStore(
      (sessionId) => store.sessionDir(sessionId),
      500,
      pushNotifier ? (sessionId, notice) => pushNotifier.notify(sessionId, notice) : undefined,
      {
        isSessionActive: async (sessionId) => {
          const session = await store.loadSession(sessionId);
          return !!session && session.status === 'running' && session.shellType !== 'shell';
        },
        onIdleCanceled: (sessionId) => pushNotifier?.cancelIdle(sessionId),
        onSubagentIdle: (signal, isCurrent) => localApiServer.notifyIdleParent(signal, isCurrent),
      },
    );
    localApiServer.setAttentionStore(attentionStore);
    const mailStore = new MailStore((sessionId) => store.sessionDir(sessionId));
    localApiServer.setMailStore(mailStore);
    const pullRequestStatuses = new PullRequestStatusService();
    let teamOutbox: PeerTeamOutbox;
    let remoteChildren: NonNullable<import('./coordination/contract.js').BoardDeps['remoteChildren']> = async () => [];
    const coordination = createCoordination({
      store,
      remotePlanLifecycle: async (child, action) => teamOutbox.plan(child, action),
      remoteEvent: (child, event) => teamOutbox.event(child, event),
      remoteParentRunning: (child) => localApiServer.managerCanAnswer(child),
      remoteChildren: id => remoteChildren(id),
      remoteResultSender: (id, manager) => localApiServer.remoteResultSender(id, manager),
      attention: attentionStore,
      prStatus: async (url) => (await pullRequestStatuses.get([url])).statuses[0] ?? null,
      prStatusFresh: (url) => pullRequestStatuses.getFresh(url),
      mail: mailStore,
      publishSession: (session) => { void centrifugo.publishSessionUpdate(userId, session); },
      now: Date.now,
      onBoardChanged: scheduleBoard,
      onAttentionEscalated: (sessionId, item) => {
        localApiServer.publishHumanAttention(sessionId, item);
      },
    });
    const sessionBoard: SessionBoardSource = {
      board: (query) => coordination.board.board(query),
      events: coordination.events,
      openAttention: (sessionId) => openBoardAttention(attentionStore, sessionId),
    };
    boardPublisher = createSessionBoardPublisher({
      source: sessionBoard, userId,
      initialSessions: (await store.listSessions()).filter(session => session.bridgeId === bridgeId),
      loadSession: async (id) => {
        const session = await store.loadSession(id);
        return session?.bridgeId === bridgeId ? session : null;
      },
      publish: (rootId, snapshot) => centrifugo.publishSessionBoard(userId, bridgeId, rootId, snapshot),
    });
    for (const rootId of bootstrapBoardRoots) boardPublisher.schedule(rootId);
    bootstrapBoardRoots.clear();
    const stopBoardObserver = centrifugo.onLocalPublication(boardPublisher.observePublication);
    localApiServer.setCoordination(coordination, scheduleBoard);
    const stopPushSessionObserver = centrifugo.onLocalPublication((channel, data) => {
      if (channel !== `sessions:updates#${userId}` || !data || typeof data !== 'object') return;
      const update = data as { type?: string; session?: { id?: string; status?: string } };
      if (update.type === 'session_update' && update.session?.id) {
        if (update.session.status === 'running') {
          coordination.onSessionStart(update.session.id);
        } else {
          void attentionStore.cancelIdleNotification(update.session.id).catch(() => { /* Removed sessions have no ledger left to update. */ });
        }
      }
    });
    const handleSessionExit = (sid: string): void => {
      unregisterSession(sid);
      void coordination.onSessionExit(sid).catch((err) => {
        console.warn(
          `[Bridge] Failed to emit exit event for ${sid}:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    };

    const notifyScriptPath = canonicalNotifyPath();

    const wireTerminalInput = (sessionId: string): void => {
      coordination.onSessionStart(sessionId);
      centrifugo.subscribeToTerminalInput(
        userId,
        sessionId,
        (sid, data) => { runner.write(sid, data); },
        (sid, cols, rows) => { handleClientResize(sid, cols, rows); },
        (sid) => { publishScreenDump(sid); },
      );
    };

    // Direct bridge-to-bridge links: cross-bridge requests leave the relay once a link to the peer is open.
    let peerLinkAdmission: Promise<void> = Promise.resolve();
    const peerLinks = new PeerLinks({
      bridgeId, endpointId: security.endpoint.id, peers: () => security.peerBridges(),
      onRevoked: listener => security.onRevoked(listener),
      execute: (packet, route) => executeSecurePacket(security, packet, route, async message => {
        if (!ready) throw new BridgeStartingError();
        return localApiServer.dispatchSecure(message);
      }, accept => {
        const accepted = peerLinkAdmission.then(accept);
        peerLinkAdmission = accepted.then(() => undefined, () => undefined);
        return accepted;
      }),
    });
    const peerControl = new PeerControl(security, centrifugo, peerLinks);
    teamOutbox = new PeerTeamOutbox(join(dataDir, 'team-outbox-' + security.endpoint.id + '.sqlite'), peerControl);
    const hierarchyWrites = new SessionHierarchyWrites();
    const sessionFactoryDeps: CreateFtownSessionDeps = {
      hierarchyWrites,
      loadRemoteParent: async (owner, id) => {
        const actor = sessionRequestPrincipal.getStore();
        if (actor && !security.permitsPeerLookup(actor)) throw new Error('Parent session unavailable');
        const result = await peerControl.http(owner, 'GET', '/api/sessions/' + encodeURIComponent(id));
        if (result.status !== 200) throw new Error('Parent session unavailable');
        if (actor) {
          await security.revalidate(actor);
          if (!security.permitsPeerLookup(actor)) throw new Error('Parent session unavailable');
        }
        return parseRemoteParent(result.body);
      },
      hasRemoteChildren: async id => {
        const snapshots = await Promise.all((await peerControl.list()).map(async peer => {
          const result = await peerControl.http(peer.bridgeId, 'GET', '/api/sessions');
          if (result.status !== 200) throw new Error('Cannot verify children on peer bridge');
          return hasPendingChild(result.body, bridgeId, id) || parsePeerSessions(result.body, peer.bridgeId)
            .some(row => row.parentSessionId === id && (row.parentBridgeId ?? row.bridgeId) === bridgeId);
        }));
        return snapshots.some(Boolean);
      },
      store,
      updateAdmission,
      runner,
      centrifugo,
      userId,
      bridgeId,
      hookPort,
      hookToken: apiToken,
      notifyScriptPath,
      wireTerminalInput,
      getTerminalSize: (sid) => terminalManager.getSize(sid),
      planStore: coordination.plan,
      remotePlanStore: owner => remoteChildPlanStore(peerControl, owner),
      releaseRemotePlan: child => teamOutbox.plan(child, 'release'),
      isWsl2,
    };
    localApiServer.setSessionFactory(sessionFactoryDeps);

    // Terminal output pump: buffers runner PTY output and owns the runner
    // 'complete'/'error' lifecycle handlers. The monitor is assigned after the
    // pump exists because classification takes the pump's write lock.
    let failureMonitor: SessionFailureMonitor | undefined;
    const terminalOutput = createTerminalOutput({
      store,
      terminalManager,
      runner,
      router: publishRouter,
      watchRegistry,
      lifecycle: {
        publishSessionUpdate: (session) => centrifugo.publishSessionUpdate(userId, session),
        publishHookEvent: (sid, event) => centrifugo.publishHookEvent(userId, sid, event),
        unregisterSession: handleSessionExit,
        collectUsage: (session) => collectSessionUsage(session),
        onOutput: (sessionId, data) => { failureMonitor?.observe(sessionId, data); },
        onLifecycle: (sessionId, event) => failureMonitor?.settle(sessionId, event) ?? Promise.resolve(),
      },
    });
    const pump = terminalOutput.pump;
    failureMonitor = new SessionFailureMonitor({
      loadSession: (id) => store.loadSession(id),
      saveSession: (session) => store.saveSession(session),
      publishSession: (session) => centrifugo.publishSessionUpdate(userId, session),
      withSessionWrite: (id, task) => pump.withSessionWrite(id, task),
      loadTerminalLog: (id) => store.loadTerminalLog(id),
      loadActivity: async (id) => (await attentionStore.list(id, { limit: 1 })).activity.state,
      listMail: async (sessionId) => (await mailStore.listAll(sessionId, 0)).map((message) => ({ from: message.from, type: message.type })),
      loadParent: child => localApiServer.loadManager(child),
      remoteResultReported: child => localApiServer.remoteResultReported(child),
      acceptMail: (parent, body) => localApiServer.mailManager(parent, body),
      recordAttention: async (sessionId, input) => {
        const item = await attentionStore.record(sessionId, 'Notification', {
          notification_type: 'agent_needs_input',
          title: input.title,
          message: input.message,
          notification_id: input.notificationId,
        });
        return item !== undefined;
      },
    });

    // Bound retained failure annotations from sessions that never emit again.
    for (const session of await store.listSessions()) {
      if (session.block) await failureMonitor.expire(session.id);
    }

    // Resurrection engine for sessions left live by a previous bridge process.
    const resurrection = new SessionResurrection({
      store,
      runner,
      bridgeId,
      sessionFactoryDeps,
      publishSessionUpdate: (session) => centrifugo.publishSessionUpdate(userId, session),
      wireTerminalInput,
      withSessionWrite: (id, task) => pump.withSessionWrite(id, task),
      // A parent that died while this bridge was down gets the same
      // parent-children escalation the live exit path runs. Settle first so
      // a session marked error without a reason still reports a failure.
      onSessionDead: async (session) => {
        await failureMonitor?.settle(session.id, { kind: 'error', message: session.errorReason ?? session.lastError });
        await coordination.onSessionExit(session.id, session);
      },
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

    // Session operations shared by local HTTP and dashboard RPC.
    // Which launch defaults the installed codex and claude understand; until it answers, the current defaults are assumed.
    void probeLaunchCapabilities().then(() => {
      if (!launchCapabilities.codexApproveForMe) console.log('[Bridge] codex predates --approve-for-me: codex sessions keep the bypass flags');
      if (!launchCapabilities.claudeAutoMode) console.log('[Bridge] claude predates auto mode: claude sessions keep their default permission mode');
    }).catch(() => {});
    const sessionController = new SessionController({
      store,
      runner,
      previewChat: new PreviewChatStore(id => store.sessionDir(id)),
      previewChatBridgeId: bridgeId,
      previewChatRunning: id => runner.isRunning(id),
      enqueuePreviewChat: (session, text) => localApiServer.enqueuePreviewChat(session, text),
      publishSessionUpdate: (session) => centrifugo.publishSessionUpdate(userId, session),
      removeSession: (id, options) => removeFtownSession({ store, runner, centrifugo, userId }, id, options),
      sessionFactory: sessionFactoryDeps,
      collectUsage: (session) => collectSessionUsage(session),
      publishSyntheticStop: (sid, reason) => pump.publishSyntheticStop(sid, reason),
      withSessionWrite: (sid, task) => pump.withSessionWrite(sid, task),
      unregisterSession: handleSessionExit,
      onSessionEnding: (session) => coordination.onSessionExit(session.id, session),
      flushTerminalBuffer: (sid) => pump.flush(sid),
      destroyTerminal: (sid) => terminalManager.destroy(sid),
    });
    // A held preview status must not keep an update waiting: once admission freezes, held requests answer within one check.
    sessionController.setPreviewWaitGate(() => !updateAdmission.isFrozen);

    localApiServer.setSessionController(sessionController);
    const pullRequestReview = createPrReviewService({ bridgeId, loadSession: id => sessionController.get(id), revalidate: principal => security.policy.revalidate(principal, 'read') });
    const pullRequestEvents = new PullRequestEventWatcher({ bridgeId, store,
      withSessionMutation: (id, task) => pump.withSessionWrite(id, task),
      statusService: pullRequestStatuses, mailStore,
      notifyCommitted: (session, sender) => localApiServer.notifyCommittedMail(session, sender, true),
    });
    pullRequestEvents.setTreeEventEmitter((session, kind, summary, ref) =>
      coordination.emit(session, kind, summary, ref),
    );
    pullRequestEvents.start();

    const updateHome = realpathSync(homedir());
    const stagingRoot = join(updateHome, '.ftown', 'updates');
    const canonicalLaunch = (() => {
      try { return commandName === 'ftown start' && realpathSync(process.argv[1]) === realpathSync(join(homedir(), '.ftown', 'cli', 'dist', 'ftown-cli.js')); }
      catch { return false; }
    })();
    const updates = new BridgeUpdateCoordinator({
      bridgeId, currentVersion: BRIDGE_VERSION, stagingRoot, resuming: !!updateRestart,
      restart: { mode: opts.local ? 'local' : 'cloud', home: updateHome, dataDir: join(updateHome, '.ftown', 'data'), cwd: process.cwd(),
        apiUrl: opts.apiUrl, bridgeId, ownerId: auth.ownerId, endpointId: security.endpoint.id },
      support: () => !opts.allowUpdates ? 'not_enabled' : process.platform === 'win32' || !!opts.solo ||
        !canonicalLaunch || realpathSync(dataDir) !== realpathSync(defaultDataDir) ? 'unsupported_launch' : null,
      busy: async () => {
        if (!resurrectionComplete || watchReattachInFlight.size) return true;
        const live = (await store.listSessions()).filter(session => session.status === 'running' || session.status === 'pending');
        const tmuxIds = new Set(live.length ? listFtownTmuxSessions() : []);
        return live.some(session => !tmuxIds.has(session.id) || session.runtime === 'direct') ||
          !runner.canDetachForUpdate(new Set(live.map(session => session.id)));
      },
      authorize: async (principal, permission) => { await security.policy.revalidate(principal, permission); },
      resolve: resolveStableRelease,
      prepare: (release, operationId, signal) => prepareRelease(release, { operationId, stagingRoot, signal }),
      discard: discardPreparedRelease,
      reserve: operationId => reserveUpdate(updateHome, operationId),
      prepareHandoff, readReceipt: () => readUpdateReceipt(stagingRoot),
      writeReceipt: receipt => { updatePhase = receipt.operation.phase; return writeUpdateReceipt(stagingRoot, receipt); },
      shutdown: () => shutdownAndExit(), admission: updateAdmission,
    });


    // Pointer lives under the instance home (see configure* above): default →
    // $HOME/.ftown (harness CLIs read it there), custom --data-dir → that dir.
    // Write and cleanup unlink MUST use this same resolved path.
    const bridgeStateDir = ftownHome;
    const bridgePointerPath = join(bridgeStateDir, 'bridge.json');
    let bridgePointerPublished = false;
    try {
      mkdirSync(bridgeStateDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        bridgePointerPath,
        JSON.stringify({
          port: hookPort,
          apiUrl: opts.apiUrl,
          // --solo only: the panel's own front origin, where invitation links belong.
          // The typeof guard keeps the extracted startup harness (index-readiness) able to run this write without the solo block.
          ...(typeof solo !== 'undefined' && solo ? { soloOrigin: `http://localhost:${solo.front.port}` } : {}),
          token: apiToken,
          dataDir, ownerId: auth.ownerId, endpoint: security.endpoint,
          bridgeId,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          harness: join(homedir(), '.ftown', 'bin', 'ftown-harness'),
          harnessCli: join(homedir(), '.ftown', 'cli', 'dist', 'ftown-cli.js'),
        }, null, 2),
        { mode: 0o600 },
      );
      bridgePointerPublished = true;
      console.log(`[Bridge] Wrote bridge pointer to ${bridgePointerPath}`);
    } catch (err) {
      console.error('[Bridge] Failed to write bridge pointer:', err);
    }

    const cleanupPointer = (): void => {
      try {
        const pointer = JSON.parse(readFileSync(bridgePointerPath, 'utf8'));
        if (pointer.pid === process.pid && pointer.token === apiToken) unlinkSync(bridgePointerPath);
      } catch { /* already gone or owned by a newer bridge */ }
    };
    process.on('exit', cleanupPointer);

    function publishScreenDump(sid: string): void {
      terminalOutput.publishScreenDump(sid);
    }

    function handleClientResize(sid: string, cols: number, rows: number): void {
      runner.resize(sid, cols, rows);
      terminalManager.resize(sid, cols, rows);
    }

    localApiServer.on('event', (hookEvent: HookEvent) => {
      let release: () => void;
      try { release = updateAdmission.enter(); } catch { return; }
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
      }).finally(release);
    });

    let ready = false;
    let shutdownRun: Promise<void> | undefined;
    const modelRouting = createRealModelRoutingService(homedir());
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const stopHandoffSession = async (id: string): Promise<void> => {
      runner.stop(id);
      const deadline = Date.now() + 6500;
      while (runner.isRunning(id) && Date.now() < deadline) await wait(50);
      if (runner.isRunning(id)) throw new Error(`could not stop old session ${id} before handoff`);
      for (let attempt = 0; attempt < 3; attempt++) {
        await killTmuxSession(id);
        if (!hasTmuxSession(id)) return;
        await wait(50);
      }
      throw new Error(`old tmux session ${id} is still running; handoff was not started`);
    };
    const runHandoff = async (sessionId: string, request: HandoffRequest) => {
      const release = hierarchyWrites.begin(sessionId);
      try {
        return await handoffSession({
          loadSession: (id) => store.loadSession(id),
          saveSession: (session) => store.saveSession(session),
          publishSession: (session) => centrifugo.publishSessionUpdate(userId, session),
          createSession: (input) => createFtownSession(sessionFactoryDeps, input),
          checkHierarchy: async session => {
            const pending = hierarchyWrites.pendingParents().some(p => p.bridgeId === bridgeId && p.id === session.id);
            const local = await store.listSessions();
            if (pending || local.some(s => s.parentSessionId === session.id && (s.parentBridgeId ?? s.bridgeId) === session.bridgeId)
              || await sessionFactoryDeps.hasRemoteChildren!(session.id)) throw new Error('Hand off the child sessions before their manager');
            if (await remotePlanBlocksHandoff(peerControl, session)) throw new Error('Release the active plan item on the parent bridge before handoff');
          },
          stopSession: stopHandoffSession,
          isSessionHealthy: (id) => waitForSessionHealthy(async () => {
            const session = await store.loadSession(id);
            return { status: session?.status, processActive: runner.isRunning(id) };
          }),
          archiveSession: async (id) => {
            const result = await sessionController.remove(id, undefined, 'keep');
            if (!result.removed) throw new Error(`could not archive session ${id}`);
          },
          plan: coordination.plan,
          loadTerminalLog: (id) => store.loadTerminalLog(id),
          routing: modelRouting,
        }, sessionId, request);
      } finally {
        release();
      }
    };
    localApiServer.setHandoff(runHandoff);
    const projectBoards = new ProjectBoardStore(dataDir, bridgeId);
    const peerCache = await startPeerSessionCache(peerControl, join(dataDir, "peer-sessions-" + security.endpoint.id + ".json"), rows => {
      for (const id of new Set(rows.filter(row => row.parentBridgeId === bridgeId).map(row => row.parentSessionId))) {
        if (id) scheduleBoard(id);
      }
    });
    remoteChildren = async (managerId) => (await peerCache.list()).flatMap(child =>
        child.parentSessionId === managerId && child.parentBridgeId === bridgeId && child.status !== 'disconnected'
          ? [{ ...child, status: child.status }] : []);
    const projectDirectory = await startPeerProjectDirectory(peerControl, join(dataDir, "peer-projects-" + security.endpoint.id + ".json"));
    const storageMoves = new ProjectStorageMoves(dataDir, bridgeId, projectBoards, peerControl, projectDirectory.rememberMove);
    localApiServer.setLocalProjects(() => projectBoards.list());
    const findDiscussionSession = (origin: string, id: string) => discussionSession(bridgeId, sid => store.loadSession(sid), peerControl, origin, id);
    localApiServer.setBoardCommands({ discussionSession: findDiscussionSession, bridgeId, security, projectBoards, storageMoves, rememberedProjects: projectDirectory.list, observeProject,
      ready: () => ready && !updateAdmission.isFrozen, deliverProject });
    const ticketInbox = new TicketNotificationInbox(join(dataDir, 'ticket-inboxes', security.endpoint.id + '.sqlite'), bridgeId);
    localApiServer.setTicketInbox(ticketInbox);
    const deliveries = new Map<string, Promise<void>>();
    function deliverProject(id: string) {
      if (!ready) return Promise.resolve(); // Unsent outbox records are retried on the next start.
      const current = deliveries.get(id);
      if (current) return current;
      const next = Promise.all([
        deliverTicketNotifications(projectBoards, ticketInbox, bridgeId, peerControl, id),
        deliverDiscussionMail(projectBoards, id, bridgeId, peerControl, sid => store.loadSession(sid),
          (session, body) => localApiServer.acceptSessionMail(session, body)),
      ]).then(() => {})
        .catch(() => console.error('[Bridge] Could not drain project notification outbox:', id))
        .finally(() => { deliveries.delete(id); });
      deliveries.set(id, next);
      return next;
    }

    const readBoardWorkers = async () => {
      const [sessions, peers] = await Promise.all([store.listSessions(), peerCache.list()]);
      const workers = [...peers, ...sessions];
      const localSessions = new Map(sessions.map(row => [row.id, row]));
      const peerWorkers = new Map(peers.map(row => [row.id, row]));
      return async (projectId: string) => {
        const board = projectBoards.inheritWorkers(projectId, workers);
        const observed = new Map<string, { status?: Session['status']; blocked?: boolean }>();
        for (const ticket of board.tickets) {
          for (const id of ticket.sessionIds) {
            const local = localSessions.get(id), remote = peerWorkers.get(id);
            const status = local?.status ?? remote?.status;
            if (!status || status === 'disconnected') continue;
            const observation = { status, blocked: remote?.boardBlocked };
            if (local) {
              try { observation.blocked = await sessionBlocksTicket(local, attentionStore); }
              catch { observation.blocked = undefined; }
            }
            observed.set(id, observation);
          }
        }
        return projectBoards.recordWorkerStates(projectId, observed);
      };
    };
    const observations = new Map<string, Promise<ProjectBoard>>();
    let loadingWorkers: ReturnType<typeof readBoardWorkers> | undefined;
    function observeProject(projectId: string) {
      const previous = observations.get(projectId);
      // Read-after-write clients receive their own newly committed snapshot, even during a background pass.
      const next = Promise.resolve(previous).catch(() => undefined).then(async () => {
        // All projects refreshing together share the session-list read. A queued refresh starts
        // after its predecessor and never replays an older worker snapshot over a newer one.
        loadingWorkers ??= readBoardWorkers().finally(() => { loadingWorkers = undefined; });
        return (await loadingWorkers)(projectId);
      })
        .finally(() => { if (observations.get(projectId) === next) observations.delete(projectId); });
      observations.set(projectId, next);
      return next;
    }
    let maintenance: Promise<void> | undefined;
    async function refreshProjects() {
      const projects = projectBoards.list();
      if (!projects.length) return;
      await Promise.all(projects.map(async ({ id }) => {
        storageMoves.recover(id);
        try { await observeProject(id); }
        catch { console.error('[Bridge] Could not refresh project workers:', id); }
        void deliverProject(id);
      }));
    }
    const ticketTimer = setInterval(() => {
      if (!ready || updateAdmission.isFrozen) return;
      void teamOutbox.flush().catch(err => console.warn('[Bridge] Failed to refresh team notifications:', err));
      maintenance ??= Promise.all([refreshProjects(), coordination.escalateOrphanedParentItems()]).then(() => {}).catch(() => console.error('[Bridge] Could not refresh project boards'))
        .finally(() => { maintenance = undefined; });
    }, 30_000);
    ticketTimer.unref();
    const hostResources = hostResourceSampler(dataDir);
    const dispatchCommand = async (message: VerifiedApplication): Promise<ApplicationJson> => {
      if (!ready) return { type: 'command_response', response: { requestId: message.envelope.messageId, success: false, error: 'bridge_offline' } };
      const route = message.application.route;
      if (route.kind !== 'command') throw new Error('Invalid command route');
      const direct = ['webrtc_offer', 'webrtc_answer', 'webrtc_ice', 'webrtc_close', 'terminal_watch', 'terminal_unwatch'].includes(route.command);
      if (direct) {
        await security.revalidate(message.principal);
        publishRouter.handleCommand(message.application.data as unknown as Parameters<typeof publishRouter.handleCommand>[0]);
        return { type: 'command_response', response: { requestId: route.requestId, success: true } };
      }
      let result: CommandResponse | undefined;
      await createCommandHandler({ bridgeId, hostResources, projectBoards, storageMoves, rememberedProjects: projectDirectory.list,
        discussionSession: findDiscussionSession, observeProject, security, sessionController, attentionStore, updates, updateEffects, pullRequestStatuses,
        directAddress: () => addressed?.address() ?? null, pullRequestReview,
        modelRouting: () => modelRouting,
        // Commands may arrive during bootstrap; only board reads resolve this late-bound source.
        get sessionBoard() { return sessionBoard; },
        enqueueSessionMessage: (session, message) => localApiServer.enqueueSessionMessage(session, message),
        acceptSessionMail: (session, body) => localApiServer.acceptSessionMail(session, body),
        handoffSession: runHandoff,
        publishAttentionChanged: (sessionId) => { localApiServer.emit('event', { sessionId, eventName: 'AttentionSnapshot', data: {} }); },
        publishCommandResponse: async response => { result = response; },
      })(message.application.data as unknown as Parameters<ReturnType<typeof createCommandHandler>>[0], message);
      if (route.command === 'mutate_project_discussion' || route.command === 'mutate_project_board' || route.command === 'get_project_board') {
        const payload = (message.application.data as { payload?: { projectId?: unknown; action?: unknown } } | null)?.payload;
        if (result?.success && payload?.action !== 'move_project' && typeof payload?.projectId === 'string') void deliverProject(payload.projectId);
      }
      return applicationJson({ type: 'command_response', response: result ?? { requestId: route.requestId, success: false, error: 'bridge_error' } });
    };
    localApiServer.setSecurity(security, { protocolVersion: 1, ownerId: auth.ownerId, bridgeId, endpoint: security.endpoint,
      relayUserId: userId }, dispatchCommand, updateEffects);
    localApiServer.setPeerControl(peerControl, peerLinks, join(dataDir, 'folder-transfers'), peerCache.list, hostResources);
    localApiServer.startInstructionSync(security.bridgeId);

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

    centrifugo.subscribeSecureCommands(userId, async message => {
      if (!ready) throw new BridgeStartingError();
      return localApiServer.dispatchSecure(message);
    }, updateEffects);
    let startupWork: Promise<void> | undefined;
    const startupTimer = setTimeout(() => {
      startupWork = (async () => {
        if (!updateRestart) {
          ready = true;
          console.log('[Bridge] Ready and listening for commands');
          if (bridgePointerPublished) {
            // Invitations are for Solo and --local only; an account bridge trusts the browsers its passkey ledger lists.
            if (opts.local || opts.solo) console.log('[Bridge] Encrypted endpoint ready. Run ftown security invite to pair a browser.');
            else console.log('[Bridge] Encrypted endpoint ready. Browsers signed in to your account with a passkey can reach this computer.');
          }
        }
        try {
          await resurrection.resurrectSessions();
          if (shutdownRun) return;
          resurrectionComplete = true;
          // Start-up sweep: parents already dead (or removed) before this
          // bridge started never hit resurrection's dead path, so escalate
          // their children's still-parent-routed items now. Idempotent with
          // the per-session escalation resurrection just ran.
          await coordination.escalateOrphanedParentItems();
          const knownSessions = await store.listSessions();
          await attentionStore.restoreIdleNotifications(knownSessions
            .filter(session => session.status === 'running' && session.shellType !== 'shell')
            .map(session => session.id));
          if (updateRestart && !shutdownRun) {
            if (!bridgePointerPublished) throw new Error('Update restart pointer unavailable');
            if (!opts.local) await centrifugo.waitUntilSecureCommandsReady(45_000);
            await finishUpdateRestartAdmission(updateAdmission, () => reportUpdateReady({ version: BRIDGE_VERSION, bridgeId, ownerId: auth.ownerId, endpointId: security.endpoint.id }));
            if (shutdownRun) return;
            ready = true;
            console.log('[Bridge] Update restart ready and listening for commands');
          }
        } catch (err) {
          console.error('[Bridge] Startup readiness failed:', err);
        }
      })();
    }, 2000);

    const autoUpdateTimer = setInterval(() => {
      if (ready) void updates.checkAutomaticUpdate().catch(error => console.error('[Bridge] Automatic update check failed:', error));
    }, 30 * 60_000);
    autoUpdateTimer.unref();

    // Leaves tmux sessions running and the process alive; a revoked restart re-executes this same PID
    // afterwards, so the local port, pointer, relay connection and timers must all be released here.
    function shutdown(): Promise<void> {
      shutdownRun ??= (async () => {
        console.log('\n[Bridge] Shutting down...');
        ready = false;
        clearTimeout(startupTimer);
        clearInterval(autoUpdateTimer);
        clearInterval(ticketTimer);
        try {
          attentionStore.stopNotifications();
          stopPushSessionObserver();
          stopBoardObserver();
          boardPublisher?.stop();
          pushNotifier?.stop();
          ledgerRelay?.stop();
          accountRegistrar?.stop();
          if (solo) {
            void solo.front.close().catch(() => {});
            solo.panel.stop();
            solo.hub.stop();
          }
          // Close ingress and release pending network requests before draining their callers.
          localApiServer.stop();
          loopbackServer.closeAll();
          addressed?.listener.stop();
          directPeers.closeAll();
          peerLinks.closeAll();
          watchRegistry.dispose();
          centrifugo.disconnect();

          const drained = await Promise.allSettled([
            teamOutbox.close(), localApiServer.closeTransfers(), peerCache.stop(), projectDirectory.stop(), pullRequestEvents.stop(),
            maintenance, ...deliveries.values(),
            // An already-started resurrection can still attach a PTY. Detach once it finishes.
            Promise.resolve(startupWork).then(() => terminalOutput.stop()),
          ]);
          for (const result of drained) if (result.status === 'rejected') throw result.reason;
        } finally {
          cleanupPointer();
          // node-datachannel module-level cleanup — avoids the native crash-on-exit race.
          try { ndcCleanup(); } catch { /* native lib already torn down */ }
          await security.close();
        }
      })();
      return shutdownRun;
    }
    const shutdownAndExit = async (): Promise<void> => {
      try { await shutdown(); } catch (err) {
        console.error('[Bridge] Shutdown failed:', err instanceof Error ? err.message : err);
        process.exit(1);
      }
      process.exit(0);
    };
    releaseForRestart = shutdown;

    let receivedStopSignal = false;
    const onStopSignal = (signal: NodeJS.Signals): void => {
      if (receivedStopSignal) {
        console.error('[Bridge] Second stop signal received; exiting immediately.');
        process.exit(signal === 'SIGINT' ? 130 : 143);
      }
      receivedStopSignal = true;
      void shutdownAndExit();
    };
    process.on('SIGINT', onStopSignal);
    process.on('SIGTERM', onStopSignal);
  });

registerLocalBrowserCommands(program);
try {
  await program.parseAsync(argv, { from: 'user' });
  return 0;
} catch (error) {
  if (error instanceof CommanderError) return error.exitCode;
  throw error;
}
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  void executeCli(() => runBridge(process.argv.slice(2)));
}
