/*
 * Account-mode startup decisions (passkey ledger), kept out of index.ts so each one is unit-tested:
 * - step 2: which identity reset runs before anything else (resetIdentityForStart);
 * - steps 3-4: pairing, ledger recovery and this bridge's own status (startAccountIdentity);
 * - steps 5-6: the first relay token (online, offline or exit) and the endpoint registration (startRelay, createEndpointRegistrar).
 * Solo and --local never enter any of it: they only finish a reset that is already pending, exactly as before.
 */
import { beginIdentityReset, completePendingIdentityReset, type IdentityResetReason, type IdentityResetResult } from './identity-reset.js';
import type { BridgeMode } from './revocation-gating.js';
import { hasLegacyAccountState, loadOrCreateLedgerIdentity, readLedgerIdentity, type LedgerBridgeIdentity } from './security/bridge/ledger-identity.js';
import { BridgeLedgerStore, LedgerStoreError, reconcileIdentityAndStore, type OwnBridgeStatus, type ReconcileResult } from './security/bridge/ledger-store.js';
import type { EndpointPublic } from './security/protocol.js';
import { MISSING_RELAY_URL_MESSAGE, isRefusal, relayTokenFailureMessage } from './ledger-relay.js';

export const LEGACY_ACCOUNT_RESET_MESSAGE = '[Bridge] Old account data from a previous ftown version was cleared. Pair this computer again with the link below.';
export const NOT_IN_LEDGER_MESSAGE = "This computer is not in your account's ledger. Run `ftown start --new-identity` to pair it again.";
export const PAIRING_REJECTED_HINT = 'Pairing did not complete. Run `ftown start` to try again.';
export const PAIRING_REVOKED_MESSAGE = "[Bridge] This computer's id was removed from the account before pairing completed. "
  + 'Run `ftown start --new-identity` to pair it with a new id.';
export const SERVER_LEDGER_MISMATCH_MESSAGE = "[Bridge] The server's account ledger does not list this computer. If it was removed from your account, run `ftown start --new-identity` to pair it again.";
export const UPDATE_RESTART_UNPAIRED_MESSAGE = '[Bridge] An update restart cannot pair this computer. Run `ftown start` to pair it.';
export const UPDATED_TO_LEDGER_MESSAGE = '[Bridge] ftown was updated to the passkey ledger; run `ftown start` to pair this computer.';
export const DIVERGED_SERVER_MESSAGE = "[Bridge] The ftown server holds a different history of your account than this computer and refused this computer's key. "
  + 'This computer keeps its own history and did not reset itself. Choose which history to keep in Security on the dashboard; '
  + 'run `ftown start --new-identity` only if you keep the server\'s.';

/** Only account bridges use the passkey ledger (legacy reset, pairing, ledger replica, relay token by proof). */
export function usesLedger(mode: BridgeMode): boolean {
  return mode === 'account';
}

export interface IdentityResetDeps {
  hasLegacyAccountState: (dataDir: string) => boolean;
  beginIdentityReset: (dataDir: string, reason: IdentityResetReason) => void;
  completePendingIdentityReset: (dataDir: string) => IdentityResetResult | null;
}

export type IdentityResetOutcome =
  | { kind: 'continue'; reset: IdentityResetResult | null }
  /** Exit 1 after printing `message`; nothing was changed on disk. */
  | { kind: 'exit'; message: string };

/**
 * Step 2. Account mode: `--new-identity`, or any v1 account state on disk, starts a manual reset (the latter says so in one line).
 * An update restart (a v1 -> v2 auto-update) has no visible terminal for the pairing link: with v1 state on disk it changes nothing
 * and exits, and the next `ftown start` resets and pairs. Every mode then finishes a pending reset, as before (a revoked restart or a
 * crash may have left one).
 */
export function resetIdentityForStart(
  input: { dataDir: string; mode: BridgeMode; newIdentity: boolean; updateRestart: boolean; log: (line: string) => void },
  deps: Partial<IdentityResetDeps> = {},
): IdentityResetOutcome {
  const legacy = deps.hasLegacyAccountState ?? hasLegacyAccountState;
  const begin = deps.beginIdentityReset ?? beginIdentityReset;
  const complete = deps.completePendingIdentityReset ?? completePendingIdentityReset;
  if (usesLedger(input.mode)) {
    if (input.newIdentity) begin(input.dataDir, 'manual');
    else if (legacy(input.dataDir)) {
      if (input.updateRestart) return { kind: 'exit', message: UPDATED_TO_LEDGER_MESSAGE };
      input.log(LEGACY_ACCOUNT_RESET_MESSAGE);
      begin(input.dataDir, 'manual');
    }
  }
  return { kind: 'continue', reset: complete(input.dataDir) };
}

export type OwnStatusAction = 'continue' | 'revoked_restart' | 'exit_absent';

/** Step 4. Only a signed revocation resets the identity; a bridge the ledger does not list fails closed and is never reset. */
export function ownStatusAction(own: OwnBridgeStatus): OwnStatusAction {
  if (own === 'active') return 'continue';
  if (own === 'revoked') return 'revoked_restart';
  return 'exit_absent';
}

/** A ledger identity bound to its account: endpoint and accountId are set. */
export type BoundLedgerIdentity = LedgerBridgeIdentity & { endpoint: EndpointPublic; accountId: string };

export type AccountStartup =
  | { kind: 'ready'; identity: BoundLedgerIdentity; store: BridgeLedgerStore; reconciled: ReconcileResult }
  | { kind: 'revoked' }
  /** Exit 1 after printing `message` (null: the cause was already printed). */
  | { kind: 'exit'; message: string | null };

export interface AccountStartupDeps {
  dataDir: string;
  bridgeId: string;
  /** False during an update restart: it must come back with its existing identity and never pair. */
  allowPairing: boolean;
  /** One pairing attempt (runLedgerPairing) with the unbound identity and the empty store; binds both on success. Throws
   *  Error('pairing_expired') (its hint already printed), Error('pairing_revoked') (the account already revokes this bridge id) or
   *  Error('pairing_rejected'). */
  pair: (identity: LedgerBridgeIdentity, store: BridgeLedgerStore) => Promise<unknown>;
  /** The server's ledger for this account (GET /api/account/ledger?accountId=…, bounded). */
  fetchLedger: (accountId: string) => Promise<unknown>;
  /** Injectable for tests. */
  loadOrCreateIdentity?: (dataDir: string) => Promise<LedgerBridgeIdentity>;
  reconcile?: (dataDir: string) => Promise<ReconcileResult>;
  readIdentity?: (dataDir: string) => Promise<LedgerBridgeIdentity | null>;
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function ledgerUnavailableMessage(reason: string): string {
  return `[Bridge] Could not load your account ledger from the server (${reason}). Check the connection and run \`ftown start\` again.`;
}

function bound(identity: LedgerBridgeIdentity | null): identity is BoundLedgerIdentity {
  return identity !== null && identity.endpoint !== null && identity.accountId !== null;
}

/**
 * Steps 3-4, account mode only, before any network use of the identity:
 * - keys exist (created when absent), then identity and replica are reconciled;
 * - 'unpaired' -> one pairing attempt (expired/rejected -> exit 1 with the hint);
 * - 'needs_ledger' -> the server ledger is adopted only through adoptBound (any failure -> exit 1; the identity stays bound);
 * - own status from the trusted replica: 'revoked' -> revoked restart; 'absent' -> exit 1 (never a reset); 'active' -> ready.
 * Corrupted local files throw (they are never reset).
 */
export async function startAccountIdentity(deps: AccountStartupDeps): Promise<AccountStartup> {
  const loadOrCreate = deps.loadOrCreateIdentity ?? loadOrCreateLedgerIdentity;
  const reconcile = deps.reconcile ?? ((dataDir: string) => reconcileIdentityAndStore(dataDir));
  const readIdentity = deps.readIdentity ?? readLedgerIdentity;

  const keys = await loadOrCreate(deps.dataDir);
  const reconciled = await reconcile(deps.dataDir);
  if (reconciled === 'unpaired') {
    if (!deps.allowPairing) return { kind: 'exit', message: UPDATE_RESTART_UNPAIRED_MESSAGE };
    try { await deps.pair(keys, new BridgeLedgerStore(deps.dataDir)); }
    catch (error) {
      const code = messageOf(error);
      if (code === 'pairing_expired') return { kind: 'exit', message: null };
      if (code === 'pairing_rejected') return { kind: 'exit', message: PAIRING_REJECTED_HINT };
      // Not a removal of a paired bridge: nothing is reset; the owner picks a new id.
      if (code === 'pairing_revoked') return { kind: 'exit', message: PAIRING_REVOKED_MESSAGE };
      throw error;
    }
  }

  const identity = await readIdentity(deps.dataDir);
  if (!bound(identity)) return { kind: 'exit', message: PAIRING_REJECTED_HINT };
  const store = new BridgeLedgerStore(deps.dataDir, { accountId: identity.accountId });
  if (reconciled === 'needs_ledger') {
    try { await store.adoptBound(await deps.fetchLedger(identity.accountId)); }
    catch (error) {
      if (error instanceof LedgerStoreError && error.code === 'ledger_store_bound_rejected') return { kind: 'exit', message: SERVER_LEDGER_MISMATCH_MESSAGE };
      return { kind: 'exit', message: ledgerUnavailableMessage(messageOf(error)) };
    }
  }

  const action = ownStatusAction(await store.ownBridgeStatus(deps.bridgeId, identity.authPublicKey));
  if (action === 'revoked_restart') return { kind: 'revoked' };
  if (action === 'exit_absent') return { kind: 'exit', message: NOT_IN_LEDGER_MESSAGE };
  return { kind: 'ready', identity, store, reconciled };
}

export type RelayStartup =
  | { kind: 'revoked' }
  /** Exit 1 after printing `message`. */
  | { kind: 'exit'; message: string }
  | { kind: 'online'; token: string; relayUrl: string }
  /** The server is unreachable for now: start with the saved relay URL and keep retrying in the background. */
  | { kind: 'offline'; relayUrl: string; reason: string };

export function offlineWithoutRelayUrlMessage(reason: string): string {
  return `[Bridge] Could not reach the ftown server (${reason}) and no relay URL was saved by an earlier start. Check the connection and run \`ftown start\` again.`;
}

/**
 * Step 5, the first relay token. A proven revocation (the token hooks offer the server's evidence first) wins over everything; a
 * refusal (401/403) exits; a temporary failure (network, timeout, 5xx, cooldown) starts offline with the saved relay URL, and exits
 * only when there is none. After a successful token the revocation is checked again: the token response's ledger may prove it.
 */
export async function startRelay(input: {
  getToken: () => Promise<string>; relayUrl: () => string | null; bridgeRevoked: () => boolean; apiUrl: string;
  /** The replica refused a different history from the server (its refusal is then about that history, not a removal of ours). */
  serverDiverged?: () => boolean;
}): Promise<RelayStartup> {
  let token: string;
  try { token = await input.getToken(); }
  catch (error) {
    if (input.bridgeRevoked()) return { kind: 'revoked' };
    if (isRefusal(error)) return { kind: 'exit', message: input.serverDiverged?.() ? DIVERGED_SERVER_MESSAGE : relayTokenFailureMessage(error, input.apiUrl) };
    const reason = messageOf(error);
    const relayUrl = input.relayUrl();
    return relayUrl === null ? { kind: 'exit', message: offlineWithoutRelayUrlMessage(reason) } : { kind: 'offline', relayUrl, reason };
  }
  if (input.bridgeRevoked()) return { kind: 'revoked' };
  const relayUrl = input.relayUrl();
  if (relayUrl === null) return { kind: 'exit', message: MISSING_RELAY_URL_MESSAGE };
  return { kind: 'online', token, relayUrl };
}

export function endpointRefusedMessage(reason: string): string {
  return `[Bridge] The ftown server refused this computer's encrypted endpoint (${reason}). If it was removed from your account, run \`ftown start --new-identity\` to pair it again.`;
}

export type RegistrationAttempt = { kind: 'registered' } | { kind: 'retry' } | { kind: 'revoked' } | { kind: 'exit'; message: string };

export interface EndpointRegistrarDeps {
  /** PUT /api/security/endpoints with this bridge's own ledger endpoint (registerBridgeEndpoint). */
  register: (token: string) => Promise<void>;
  tokens: { getToken(): Promise<string>; cooldownRemainingMs(): number };
  bridgeRevoked: () => boolean;
  log: (line: string) => void;
  /** Returns a cancel function. Defaults to an unref'd setTimeout. */
  schedule?: (run: () => void, ms: number) => () => void;
  /** First background delay (default 15 s), doubling to maxDelayMs (default 10 min); never earlier than the token cooldown. */
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface EndpointRegistrar {
  /** Step 6 at an online start, with the first token: a refusal exits, a temporary failure is retried in the background. */
  registerNow(token: string): Promise<RegistrationAttempt>;
  /** Retries getToken() + registration in the background until it succeeds or is refused, honouring the token cooldown. */
  retryInBackground(): void;
  registered(): boolean;
  stop(): void;
}

export function createEndpointRegistrar(deps: EndpointRegistrarDeps): EndpointRegistrar {
  const schedule = deps.schedule ?? ((run: () => void, ms: number) => { const timer = setTimeout(run, ms); timer.unref(); return () => clearTimeout(timer); });
  const maxDelay = deps.maxDelayMs ?? 600_000;
  let delay = deps.baseDelayMs ?? 15_000;
  let done = false;
  let stopped = false;
  let cancel: (() => void) | null = null;

  const next = (): void => {
    const wait = Math.max(deps.tokens.cooldownRemainingMs(), delay);
    delay = Math.min(delay * 2, maxDelay);
    cancel = schedule(() => { cancel = null; void attempt(); }, wait);
  };
  const attempt = async (): Promise<void> => {
    if (done || stopped) return;
    try {
      await deps.register(await deps.tokens.getToken());
      done = true;
      deps.log('[Bridge] Registered this computer\'s encrypted endpoint.');
    } catch (error) {
      if (stopped) return;
      if (isRefusal(error)) {
        // A verified revocation restarts the bridge on its own; anything else needs the owner.
        if (!deps.bridgeRevoked()) deps.log(endpointRefusedMessage(messageOf(error)));
        stopped = true;
        return;
      }
      next();
    }
  };

  return {
    async registerNow(token) {
      try {
        await deps.register(token);
        done = true;
        return { kind: 'registered' };
      } catch (error) {
        if (deps.bridgeRevoked()) return { kind: 'revoked' };
        if (isRefusal(error)) return { kind: 'exit', message: endpointRefusedMessage(messageOf(error)) };
        deps.log(`[Bridge] Could not register this computer's encrypted endpoint yet (${messageOf(error)}); retrying in the background.`);
        return { kind: 'retry' };
      }
    },
    retryInBackground() {
      if (done || stopped || cancel !== null) return;
      next();
    },
    registered: () => done,
    stop() {
      stopped = true;
      cancel?.();
      cancel = null;
    },
  };
}
