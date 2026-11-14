#!/usr/bin/env node

import { Command as Commander, CommanderError } from 'commander';
import { v4 as uuidv4 } from 'uuid';
import { resolve, dirname, join } from 'node:path';
import { hostname as osHostname, networkInterfaces, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, realpathSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { cleanup as ndcCleanup } from 'node-datachannel';
import { configureUpdateOptions } from './update-options.js';

import { CentrifugoClient, type LedgerMessage } from './centrifugo-client.js';
import { WatchRegistry } from './direct-transport/watch-registry.js';
import { DirectPeerManager } from './direct-transport/peer-manager.js';
import { PublishRouter } from './direct-transport/publish-router.js';
import { LoopbackPeerServer } from './direct-transport/loopback-server.js';
import { toWireSession } from './session-wire.js';
import { ProcessRunner } from './claude-runner.js';
import { SessionStore } from './session-store.js';
import { MailStore } from './mail-store.js';
import { AttentionStore } from './attention-store.js';
import type { AttentionItem } from './attention-events.js';
import { PreviewChatStore } from './preview-chat.js';
import { BridgePushNotifier } from './push-notifier.js';
import { LocalApiServer } from './local-api-server.js';
import { BrowserAccess } from './browser-access.js';
import { registerLocalBrowserCommands } from './local-pair-cli.js';
import type { CommandResponse } from './types.js';
import { TerminalManager } from './terminal-manager.js';
import { assertSetupReady } from './setup-state.js';
import { canonicalNotifyPath } from './install-notify-script.js';
import { unregisterSession, configureSessionRegistryHome } from './session-registry.js';
import { createFtownSession, type CreateFtownSessionDeps } from './create-ftown-session.js';
import { loadOrCreateIdentity, readBoundBridgeIdentity } from './security/bridge/identity.js';
import { bindLedgerIdentity } from './security/bridge/ledger-identity.js';
import { BridgeSecurityService, applicationJson } from './security/bridge/security.js';
import type { ApplicationJson, EndpointIdentity, VerifiedApplication } from './security/protocol.js';
import { createCommandHandler } from './command-rpc.js';
import { createRealModelRoutingService } from './quota/routing-service.js';
import { PullRequestStatusService } from './pull-request-status.js';
import { createPrReviewService } from './pull-request-review.js';
import { PullRequestEventWatcher } from './pull-request-events.js';
import { createCoordination } from './coordination/wiring.js';
import { removeFtownSession } from './remove-ftown-session.js';
import { SessionResurrection, shouldResurrectStoredSession } from './session-resurrection.js';
import { createTerminalOutput } from './terminal-output.js';
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

export async function runBridge(argv: string[], commandName = 'ftown-bridge'): Promise<number> {
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
      releaseForRestart = async () => { relay.stop(); localApiServer.stop(); await ledgerSecurity.close(); };
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
    // Account mode only: the ledger channel's records and (re)subscriptions feed the replica.
    const ledgerRelay = accountRelay;
    const ledgerOptions = ledgerRelay ? {
      onLedgerMessage: (message: LedgerMessage) => ledgerRelay.onLedgerMessage(message),
      onLedgerSubscribed: () => ledgerRelay.onLedgerSubscribed(),
    } : {};
    const centrifugo = new CentrifugoClient(centrifugoUrl, auth.token, getToken, {
      ...ledgerOptions,
      disabled: opts.local,
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
      onAttach: (sid, deliver) => terminalOutput.attachScreen(sid, deliver),
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
      onAttach: (sid, deliver) => terminalOutput.attachScreen(sid, deliver),
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
      let release: () => void;
      try { release = updateAdmission.enter(); } catch { return; }
      watchReattachInFlight.add(sid);
      void store.loadSession(sid)
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
    const coordination = createCoordination({
      store,
      attention: attentionStore,
      prStatus: async (url) => (await pullRequestStatuses.get([url])).statuses[0] ?? null,
      mail: mailStore,
      publishSession: (session) => { void centrifugo.publishSessionUpdate(userId, session); },
      now: Date.now,
      onAttentionEscalated: (sessionId, item) => {
        localApiServer.publishHumanAttention(sessionId, item);
      },
    });
    localApiServer.setCoordination(coordination);
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

    const sessionFactoryDeps: CreateFtownSessionDeps = {
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
    };
    localApiServer.setSessionFactory(sessionFactoryDeps);

    // Terminal output pump: buffers runner PTY output and owns the runner
    // 'complete'/'error' lifecycle handlers.
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
      },
    });
    const pump = terminalOutput.pump;

    // Resurrection engine for sessions left live by a previous bridge process.
    const resurrection = new SessionResurrection({
      store,
      runner,
      bridgeId,
      sessionFactoryDeps,
      publishSessionUpdate: (session) => centrifugo.publishSessionUpdate(userId, session),
      wireTerminalInput,
      withSessionWrite: (id, task) => pump.withSessionWrite(id, task),
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
      busy: async () => !resurrectionComplete || runner.hasLiveGenerations() || !pump.isIdle() || watchReattachInFlight.size > 0 ||
        (await store.listSessions()).some(session => session.status === 'running' || session.status === 'pending'),
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
    const modelRouting = createRealModelRoutingService(homedir());
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
      await createCommandHandler({ bridgeId, security, sessionController, attentionStore, updates, updateEffects, pullRequestStatuses, pullRequestReview,
        modelRouting: () => modelRouting,
        sessionBoard: {
          board: (query) => coordination.board.board(query),
          // Read when get_session_board asks. An eager property would touch
          // coordination while every other command is building its handler.
          get events() { return coordination.events; },
          openAttention: (sessionId) => openBoardAttention(attentionStore, sessionId),
        },
        enqueueSessionMessage: (session, message) => localApiServer.enqueueSessionMessage(session, message),
        acceptSessionMail: (session, body) => localApiServer.acceptSessionMail(session, body),
        publishAttentionChanged: (sessionId) => { localApiServer.emit('event', { sessionId, eventName: 'AttentionSnapshot', data: {} }); },
        publishCommandResponse: async response => { result = response; },
      })(message.application.data as unknown as Parameters<ReturnType<typeof createCommandHandler>>[0], message);
      return applicationJson({ type: 'command_response', response: result ?? { requestId: route.requestId, success: false, error: 'bridge_error' } });
    };
    localApiServer.setSecurity(security, { protocolVersion: 1, ownerId: auth.ownerId, bridgeId, endpoint: security.endpoint,
      relayUserId: userId }, dispatchCommand, updateEffects);

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
      if (!ready) throw new Error('Bridge is starting');
      return localApiServer.dispatchSecure(message);
    }, updateEffects);
    setTimeout(() => {
      void (async () => {
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
          resurrectionComplete = true;
          const knownSessions = await store.listSessions();
          await attentionStore.restoreIdleNotifications(knownSessions
            .filter(session => session.status === 'running' && session.shellType !== 'shell')
            .map(session => session.id));
          if (updateRestart) {
            if (!bridgePointerPublished) throw new Error('Update restart pointer unavailable');
            if (!opts.local) await centrifugo.waitUntilSecureCommandsReady(45_000);
            await finishUpdateRestartAdmission(updateAdmission, () => reportUpdateReady({ version: BRIDGE_VERSION, bridgeId, ownerId: auth.ownerId, endpointId: security.endpoint.id }));
            ready = true;
            console.log('[Bridge] Update restart ready and listening for commands');
          }
        } catch (err) {
          console.error('[Bridge] Startup readiness failed:', err);
        }
      })();
    }, 2000);

    // Leaves tmux sessions running and the process alive; a revoked restart re-executes this same PID
    // afterwards, so the local port, pointer, relay connection and timers must all be released here.
    let shutdownRun: Promise<void> | undefined;
    function shutdown(): Promise<void> {
      shutdownRun ??= (async () => {
        console.log('\n[Bridge] Shutting down...');
        try {
          await pullRequestEvents.stop();
          attentionStore.stopNotifications();
          stopPushSessionObserver();
          pushNotifier?.stop();
          ledgerRelay?.stop();
          accountRegistrar?.stop();
          // Solo L2 ordering: stop accepting first, then children (panel before
          // hub), then the rest of the bridge teardown.
          if (solo) {
            void solo.front.close().catch(() => {});
            solo.panel.stop();
            solo.hub.stop();
          }
        } finally {
          // The port and the pointer would outlive a same-PID re-exec, so no earlier failure may skip them.
          try { localApiServer.stop(); } finally { cleanupPointer(); }
        }
        await terminalOutput.stop();
        loopbackServer.closeAll();
        directPeers.closeAll();
        watchRegistry.dispose();
        // node-datachannel module-level cleanup — avoids the native crash-on-exit race.
        try { ndcCleanup(); } catch { /* native lib already torn down */ }
        centrifugo.disconnect();
        try { await security.close(); }
        catch (err) { console.error('[Bridge] Failed to persist security shutdown state.'); throw err; }
      })();
      return shutdownRun;
    }
    const shutdownAndExit = async (): Promise<void> => {
      try { await shutdown(); } catch { process.exit(1); }
      process.exit(0);
    };
    releaseForRestart = shutdown;

    process.on('SIGINT', () => { void shutdownAndExit(); });
    process.on('SIGTERM', () => { void shutdownAndExit(); });
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
