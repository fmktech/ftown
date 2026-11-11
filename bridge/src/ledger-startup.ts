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
export const DO_NOT_RESET_LINE = '[Bridge] Do NOT run --new-identity: this computer may hold the only copy. Open Security in the dashboard to choose a history.';
export const HELD_OFFLINE_LINE = '[Bridge] Starting offline: local sessions keep working, and the relay is retried in the background.';
export const HELD_NO_RELAY_URL_LINE = '[Bridge] No relay URL was saved by an earlier start, so this computer cannot start offline. Run `ftown start` again later.';

/** What this computer holds that the server lacks (BridgeSecurityService.uniqueHistory), for the held-history notice. */
export interface HeldHistory { afterRevision: number; records: number; removals: number; passkeys: number }

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
/** Printed once when the server refuses the key of a computer that is an active member of its own history (step 5): never reset advice. */
export function heldHistoryNotice(unique: HeldHistory | null): string[] {
  const detail = unique === null || unique.records === 0
    ? 'this computer holds changes the server does not have'
    : `this computer holds account history the server does not have: ${plural(unique.removals, 'removal')} and ${plural(unique.passkeys, 'passkey')} `
      + `among ${plural(unique.records, 'change')} after revision ${unique.afterRevision}`;
  return [`[Bridge] The ftown server refused this computer's key, and ${detail}.`, DO_NOT_RESET_LINE];
}

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
    try { await deps.pair(keys, new BridgeLedgerStore(deps.dataDir, { bridgeId: deps.bridgeId })); }
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
  const store = new BridgeLedgerStore(deps.dataDir, { accountId: identity.accountId, bridgeId: deps.bridgeId });
  if (reconciled === 'needs_ledger') {
    try { await store.adoptBound(await deps.fetchLedger(identity.accountId)); }
    catch (error) {
      if (error instanceof LedgerStoreError && error.code === 'ledger_store_bound_rejected') return { kind: 'exit', message: SERVER_LEDGER_MISMATCH_MESSAGE };
      return { kind: 'exit', message: ledgerUnavailableMessage(messageOf(error)) };
    }
  }

  const action = ownStatusAction(await store.ownBridgeStatus({
    bridgeId: deps.bridgeId, endpointId: identity.endpoint.id, endpointPublicKey: identity.endpoint.publicKey, authPublicKey: identity.authPublicKey,
  }));
  if (action === 'revoked_restart') return { kind: 'revoked' };
  if (action === 'exit_absent') return { kind: 'exit', message: NOT_IN_LEDGER_MESSAGE };
  return { kind: 'ready', identity, store, reconciled };
}

export type RelayStartup =
  | { kind: 'revoked' }
  /** Exit 1 after printing `message`. */
  | { kind: 'exit'; message: string }
  | { kind: 'online'; token: string; relayUrl: string }
  /** The server is unreachable for now, or refused a computer that may hold the only copy of its history (`notice`, printed once instead
   *  of the unreachable line): start with the saved relay URL and keep retrying in the background. */
  | { kind: 'offline'; relayUrl: string; reason: string; notice?: string[] };

export function offlineWithoutRelayUrlMessage(reason: string): string {
  return `[Bridge] Could not reach the ftown server (${reason}) and no relay URL was saved by an earlier start. Check the connection and run \`ftown start\` again.`;
}

/**
 * Step 5, the first relay token. A proven revocation (the token hooks offer the server's evidence first) wins over everything. A refusal
 * (401/403) of a computer that is still an active member of its own history (`held` returns the notice: a divergence with the server, a
 * server behind us, a failed re-offer, or any refusal without proof of our removal) starts OFFLINE and prints the notice once, never the
 * reset advice: this computer may hold the only copy. Any other refusal (this computer is not an active member: unpaired/absent) exits
 * with the reset advice. A temporary failure (network, timeout, 5xx, cooldown) starts offline with the saved relay URL. Without a saved
 * relay URL there is no offline start: exit. After a successful token the revocation is checked again (the token response's ledger may
 * prove it).
 */
export async function startRelay(input: {
  getToken: () => Promise<string>; relayUrl: () => string | null; bridgeRevoked: () => boolean; apiUrl: string;
  /** The held-history notice when this computer is an active member of its own history (heldHistoryNotice), else null. */
  held?: () => string[] | null;
}): Promise<RelayStartup> {
  let token: string;
  try { token = await input.getToken(); }
  catch (error) {
    if (input.bridgeRevoked()) return { kind: 'revoked' };
    if (isRefusal(error)) {
      const notice = input.held?.() ?? null;
      if (notice === null) return { kind: 'exit', message: relayTokenFailureMessage(error, input.apiUrl) };
      const savedUrl = input.relayUrl();
      if (savedUrl === null) return { kind: 'exit', message: [...notice, HELD_NO_RELAY_URL_LINE].join('\n') };
      return { kind: 'offline', relayUrl: savedUrl, reason: messageOf(error), notice: [...notice, HELD_OFFLINE_LINE] };
    }
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
  /** This computer is an active member of its own history: a refusal is then not final (it may hold the only copy; the startup notice
   *  said so): no reset advice, keep retrying with the backoff until the server accepts the key again. */
  held?: () => boolean;
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
      if (isRefusal(error) && !deps.held?.()) {
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
        if (isRefusal(error) && !deps.held?.()) return { kind: 'exit', message: endpointRefusedMessage(messageOf(error)) };
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
