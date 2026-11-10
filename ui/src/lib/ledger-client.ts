import {
  accountIdOf, chooseLedger, describeFork, LedgerError, ledgerHead, ledgerLastIssuedAt, ledgerRevocations, nextTransition, parseLedger, relateHead,
  resolutionPlan, resolveForkTransition, verifyLedger,
} from "@security/ledger/ledger";
import type { LedgerFork, LedgerRelation } from "@security/ledger/ledger";
import { bridgeFromPairRequest, pairComparisonCode, parsePairLink, sealPairApproval } from "@security/ledger/pairing";
import { signAuthProof } from "@security/ledger/proof";
import { LEDGER_LIMITS } from "@security/ledger/protocol";
import type { Ledger, LedgerCheckpoint, LedgerGenesis, LedgerOperation, LedgerTransition, PasskeySignature, Signed } from "@security/ledger/protocol";
import type { EndpointIdentity, EndpointPublic } from "@security/protocol";
import type * as PasskeyModule from "./passkey";
import type { DivergentChain, LedgerReplica, LedgerSource, PendingWriteRecord, ReplicaOffer, ReplicaOfferOptions } from "./ledger-replica";

/*
 * Browser client of the passkey ledger. Every ledger write is a passkey-signed transition built on the replica's RAW checkpoint; every
 * trust decision (membership, bridge access) uses replica.trusted(), which applies sticky revocations. The replica binds only to a chain
 * this client verified itself: its own signed chain, or a chain fetched by the passkey's handle whose genesis carries that handle and whose
 * verified authorities include the identifying credential. Each WebAuthn ceremony has its own public step so the UI can run it from its
 * own user gesture (Safari); the combined methods only chain those steps. Errors are Error(code) with a stable snake_case message.
 *
 * Append-only, the server is the sequencer. The replica follows chooseLedger only: it adopts a chain that strictly extends its own,
 * keeps its own against one that is the same or behind, and never adopts a valid different history (that raises the divergence state,
 * which only the owner's resolveDivergence() ends).
 * - A user-signed change is NOT put in the replica before the server accepts it: fresh read (adopting a server chain that is ahead) ->
 *   beforeSign hook -> passkey -> the record is persisted as the ONE pending write -> POST of local + record with `expectHead` (the server
 *   head just read) -> the replica adopts the chain the server answers with. A 409 whose chain is ahead of the local one (another change
 *   landed first) is adopted and the record dropped (write_conflict; it is kept in discarded() for signing again, never re-signed
 *   automatically). A failed or refused request keeps it pending: it is retried with the re-offer pacing below while the local chain is
 *   still the head it was signed on, delivered once the server's chain holds it, and dropped (write_conflict) once the local chain moved.
 * - Re-offer: when a server read or a POST answer shows the server's chain `behind` the local one (a rolled-back database), the client
 *   POSTs its own chain again, without a prompt: one run at a time on the exclusive() queue, the same (candidate, server) pair at most
 *   once per 30 s, failures backed off (30 s doubling to 10 min, ±20%, never sooner than Retry-After) by one retry timer. Every attempt
 *   first reads the server again (so a deleted account, or a revocation of this very browser made elsewhere, is seen before anything is
 *   sent) and then POSTs with `expectHead`: the server refuses (409 head_changed) if its chain moved since, and never creates an account
 *   for it (404 account_unknown). The pending write is delivered by the same runs (local + record).
 * - Nothing is POSTed or re-offered while a divergence holds, and user writes are refused with ledger_diverged.
 * Relay input is not proof of the server's state (anyone holding a token can publish on the channel): an older head or a shorter
 * pushed chain only causes a paced read, and that read decides. An invalid chain from anywhere is ignored (one console.warn).
 * Backoff, pair memory and the retry timer are per tab (per LedgerClient); the pending write is persisted with the replica, so every tab
 * of the profile sees it and a reload resumes it.
 */

export type AttemptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface LedgerClientDeps {
  /** Exact page origin (URL.origin): the genesis origin and the audience of session proofs. */
  origin: string;
  /** location.origin of the running page. Account creation refuses unless it equals `origin`. */
  pageOrigin: string;
  /** The server's configured public origin (FTOWN_PUBLIC_URL). Account creation refuses unless it equals `origin`. */
  publicOrigin: string;
  rpId: string;
  fetchImpl?: typeof fetch;
  replica: LedgerReplica;
  passkey: typeof PasskeyModule;
  deviceKey: () => Promise<{ publicKey: string; privateKey: CryptoKey }>;
  /** This browser's ECDH endpoint owned by `accountId` (wave 4: `loadBrowserIdentity`). */
  endpoint: (accountId: string) => Promise<EndpointIdentity>;
  /** Deletes this browser's endpoint identity for `accountId` and its device auth key, so endpoint()/deviceKey() create new ones. */
  resetDeviceIdentity: (accountId: string) => Promise<void>;
  /** next-auth `signIn('ledger', { proof, redirect: false })` wrapper. */
  signIn: (proofJson: string) => Promise<boolean>;
  /** Pairing-code attempt counters; must survive a reload (wave 4: sessionStorage). Default: this page only. */
  attemptStorage?: AttemptStorage;
  now?: () => number;
  /** Jitter source of the re-offer backoff, in [0, 1). Default Math.random. */
  random?: () => number;
  /**
   * Runs in every user-signed write (and resolveDivergence) after the fresh read and before any passkey prompt, with the local head the
   * change is about to be built on. Default: nothing. It may feed chains it obtains into learnChain(), which then runs at once instead of
   * waiting for the queue this write holds; the write re-reads the local chain afterwards and builds on the head it then holds. A throw
   * aborts the write before any prompt.
   */
  beforeSign?: (head: { revision: number; head: string }) => Promise<void>;
}
export type LedgerClientPending = "none" | "passkey_created" | "enrollment_ready" | "authority_created" | "authority_consented";
/** The target of a signed change: its operation and, for a browser or computer, its endpoint id or bridgeId. */
export interface LedgerWriteTarget { operation: LedgerOperation["type"]; deviceId?: string; bridgeId?: string }
/** The one passkey-signed change the server has not accepted yet. `since`: when it was signed (epoch ms). */
export interface LedgerPendingWrite extends LedgerWriteTarget { since: number }
/**
 * The last signed change that was dropped without becoming part of the account (its record is in `discarded` for signing again).
 * `reason`: write_conflict (another change landed first: confirm again), ledger_diverged (a different history appeared), or the code of
 * a definitive refusal (ledger_rejected, ledger_limit, registration_closed). `at`: when it was dropped (epoch ms).
 */
export interface LedgerWriteConflict extends LedgerWriteTarget { at: number; reason: string }
/**
 * One side of a divergence as resolveDivergence would keep it. `carry`: the operations of the OTHER branch (its removals and added
 * passkeys) that keeping this side signs again on top of it, in order: carry.length + 1 passkey confirmations in all. `canKeep` false
 * when one of those records cannot be built on this side (`reason`: its error code, e.g. ledger_limit past the passkey limit, or
 * invalid_ledger when this side holds that credential or key under another passkey); `reason` is null when it can.
 */
export interface LedgerDivergenceSide { carry: LedgerOperation[]; canKeep: boolean; reason: string | null }
/**
 * A valid history of the account that diverges from the local chain. `source`: where it was learnt (the server's read or answer, a
 * relay push, or a peer through learnChain). `fork`: describeFork(local, other). `mine` / `theirs`: what keeping this browser's history
 * or the other one takes (see LedgerDivergenceSide).
 */
export interface LedgerDivergence {
  other: Ledger;
  source: LedgerSource;
  fork: LedgerFork;
  firstSeen: number;
  mine: LedgerDivergenceSide;
  theirs: LedgerDivergenceSide;
}
export interface LedgerClientSnapshot {
  /** device_revoked: the account is known but this browser's keys are revoked (or replaced); see rotateDeviceIdentity(). */
  status: "signed_out" | "ready" | "device_revoked" | "error";
  /** trusted(): sticky revocations applied. */
  checkpoint: LedgerCheckpoint | null;
  /** Records to sign again (own signed changes the server never took, local records a resolve_fork dropped); persisted until dismissed or effective. */
  discarded: Signed<LedgerTransition>[];
  /** Ids revoked only on this browser: in the sticky set but still present in the RAW chain. revokeDevice/revokeBridge accept them. */
  localOnly: { deviceIds: string[]; bridgeIds: string[] };
  /** The credential this device is known to hold (the only authority, or learned from a prompt or a signature), else null. */
  signer: string | null;
  /** Which multi-gesture flow is half done. */
  pending: LedgerClientPending;
  /*
   * Server agreement. Every field below is set on every published snapshot; they are optional only for hand-built snapshots (the SSR
   * placeholder, test fixtures).
   */
  /**
   * The signed change waiting for the server (never part of `checkpoint`: until the server accepts it, nothing has changed). Hidden
   * while its first request is in flight. Null when none. While it is set every other user write is refused with write_pending.
   */
  pendingWrite?: LedgerPendingWrite | null;
  /** The last signed change dropped without being saved (see LedgerWriteConflict), until the next user write, dismissDiscarded() or forget(). */
  lastConflict?: LedgerWriteConflict | null;
  /** A valid different history of the account (see LedgerDivergence), or null. While set nothing is sent and user writes are refused. */
  divergence?: LedgerDivergence | null;
  /**
   * What the server holds for the bound account, as last confirmed (a read or a POST answer in this page, else the state persisted
   * with the replica): 'current' = the local chain; 'behind' = a prefix of it; 'unknown' = nothing confirmed (never read in this
   * profile, the account gone from the server, its last answer refused, or a different history) or unbound.
   */
  serverState?: "unknown" | "current" | "behind";
  /**
   * Removals the server does not hold yet, so it still accepts their targets: the pending write's target when it is a removal, plus every
   * id the local chain revokes and the server's confirmed chain does not while serverState is 'behind' (a rolled-back server). The client
   * sends both by itself (see retryNow). Empty otherwise.
   */
  unsaved?: { deviceIds: string[]; bridgeIds: string[] };
  /** When the next automatic attempt (pending write or re-offer) is scheduled (epoch ms), or null when none is. */
  retryAt?: number | null;
  /**
   * The deadline of the server's last Retry-After (epoch ms) since the server last took a POST: retryNow() sends nothing before it.
   * It is not re-published when it passes, so compare it with the clock; null when there is none.
   */
  retryNotBefore?: number | null;
  /**
   * This browser may re-offer its chain: bound, not creating an account, its own keys a trusted device or revoked by its own chain.
   * False when its own removal is only in the sticky set (kept from a replica of older code). The pending write does not need it.
   */
  canReoffer?: boolean;
  error?: string;
}

const RP_NAME = "FTown";
const REQUEST_TIMEOUT_MS = 15000;
/** Minimum spacing of ledger reads (the server allows 120/min per IP); requests inside it are deferred, never dropped. */
const REFRESH_SPACING_MS = 2000;
const MAX_RESPONSE_CHARS = LEDGER_LIMITS.maxBytes + 65536;
const MAX_CODE_ATTEMPTS = 5;
const ATTEMPT_KEY = "ftown-pair-attempts:";
const HANDLE = /^[A-Za-z0-9_-]{43}$/;
const SOFT_REFRESH_ERRORS = ["network_unavailable", "server_unavailable", "account_not_found"];
/** Re-offer pacing: the same (local head, server head) pair is sent at most once per window. */
const REOFFER_PAIR_MS = 30_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 600_000;
const BACKOFF_JITTER = 0.2;
/** Longest Retry-After honoured; a larger value is read as this, so a retry still happens eventually. */
const MAX_RETRY_AFTER_MS = 3_600_000;
/** Refusals of a POST that no later attempt of the same signed record can change (its pending write is dropped). */
const DEFINITIVE_STATUSES = [400, 403, 413];
/** Which divergent chain the snapshot shows (and resolveDivergence resolves) first. */
const DIVERGENCE_ORDER: readonly LedgerSource[] = ["server", "peer", "relay"];
/** At most this many distinct invalid chains are remembered for the one-warning-each rule. */
const MAX_WARNED_INVALID = 64;

/**
 * A refused or failed POST of a chain (see store()). `retryAfterMs`: the answer's Retry-After. `answered`: a 409 that carried the
 * server's chain, which was already offered to the replica. `status`: the HTTP status, when there was an answer.
 */
class StoreError extends Error {
  constructor(message: string, readonly retryAfterMs?: number, readonly answered = false, readonly status?: number) {
    super(message);
  }
}
/** The result of one POST of the pending write (see sendPending). */
type Delivery = { kind: "delivered" } | { kind: "dropped"; code: string } | { kind: "kept"; code: string; retryAfterMs?: number; answered: boolean };
/** What reconcilePending found: no pending write, one still deliverable, or one it just settled. */
type Reconciled = "none" | "live" | "delivered" | "write_conflict" | "ledger_diverged";
function targetOf(operation: LedgerOperation): LedgerWriteTarget {
  switch (operation.type) {
    case "revoke_device": return { operation: operation.type, deviceId: operation.endpointId };
    case "add_device": return { operation: operation.type, deviceId: operation.device.endpoint.id };
    case "revoke_bridge": return { operation: operation.type, bridgeId: operation.bridgeId };
    case "add_bridge": return { operation: operation.type, bridgeId: operation.bridge.bridgeId };
    default: return { operation: operation.type };
  }
}
/**
 * A user removal names a member of the RAW chain; nextTransition would sign any other id as a tombstone. `revoked`: the code for an id
 * the chain already removed (append(): ledger_revoked, as the ledger reported it before; revokeDevice/revokeBridge: not found).
 */
function memberCheck(checkpoint: LedgerCheckpoint, operation: LedgerOperation, revoked?: string): void {
  if (operation.type === "revoke_device" && !checkpoint.devices.some(item => item.endpoint.id === operation.endpointId)) {
    throw new Error(revoked !== undefined && checkpoint.revokedDeviceIds.indexOf(operation.endpointId) !== -1 ? revoked : "device_not_found");
  }
  if (operation.type === "revoke_bridge" && !checkpoint.bridges.some(item => item.bridgeId === operation.bridgeId)) {
    throw new Error(revoked !== undefined && checkpoint.revokedBridgeIds.indexOf(operation.bridgeId) !== -1 ? revoked : "bridge_not_found");
  }
}
/** `base` with `records` appended. */
function appended(base: Ledger, records: readonly Signed<LedgerTransition>[]): Ledger {
  return { genesis: base.genesis, transitions: base.transitions.concat(records) };
}
/** Retry-After as milliseconds (delta-seconds or an HTTP date), capped at MAX_RETRY_AFTER_MS; undefined when absent or unreadable. */
function retryAfterOf(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^[0-9]{1,10}$/.test(text)) return Math.min(Number(text) * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS) : undefined;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function b64url(data: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < data.length; index += 1) binary += String.fromCharCode(data[index]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
/** Server rejection reasons of an account creation (POST /api/account/ledger without a stored account), surfaced as client codes of the same name. */
const CREATION_REASONS = ["registration_closed", "creation_too_large", "invalid_ledger", "origin_mismatch", "server_full", "handle_taken", "rate_limited", "server_misconfigured"];
function canonicalOrigin(value: unknown): string {
  try { return typeof value === "string" ? new URL(value).origin : ""; } catch { return ""; }
}
function requireSecureContext(): void {
  if (typeof crypto === "undefined" || !crypto || !crypto.subtle) throw new Error("secure_context_required");
}
/** Stable codes only: LedgerError becomes its code; any other message that is not a snake_case code becomes unknown_error. */
function code(error: unknown): string {
  const pattern = /^[a-z][a-z0-9_]{0,63}$/;
  if (error instanceof LedgerError) return error.code;
  if (error instanceof Error && pattern.test(error.message)) return error.message;
  // SecurityError (crypto.ts) carries its code beside a human sentence.
  const tagged = isPlain(error) || error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof tagged === "string" && pattern.test(tagged) ? tagged : "unknown_error";
}
function coded(error: unknown): Error {
  return error instanceof Error && !(error instanceof LedgerError) && code(error) === error.message ? error : new Error(code(error));
}
/** True iff `ledger` parses and its record at `revision` has head `head`. */
async function holds(ledger: unknown, revision: number, head: string): Promise<boolean> {
  try {
    const record = parseLedger(ledger).transitions[revision - 1];
    return record !== undefined && await ledgerHead(record.payload) === head;
  } catch {
    return false;
  }
}

// Zero-width, bidi and other invisible format characters (incl. ZWJ, LRM/RLM, ALM, BOM), C0/C1 controls, line/paragraph separators.
const INVISIBLE: readonly [number, number][] = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x00ad, 0x00ad], [0x061c, 0x061c], [0x180e, 0x180e], [0x200b, 0x200f],
  [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0xfeff, 0xfeff],
];

/** A one-unit symbol in the surrogate range (Array.from yields valid pairs as one two-unit symbol), or an invisible code point. */
function stripped(symbol: string): boolean {
  const point = symbol.codePointAt(0) ?? 0;
  if (symbol.length === 1 && point >= 0xd800 && point <= 0xdfff) return true;
  return INVISIBLE.some(([low, high]) => point >= low && point <= high);
}

/** Label input for signed records: NFC, invisible/bidi/control characters and lone surrogates removed, trimmed, at most 200 UTF-16 units. */
export function sanitizeLabel(input: string): string {
  // Array.from splits by code point, so a valid surrogate pair is never cut in half.
  const text = Array.from(String(input).normalize("NFC")).filter(symbol => !stripped(symbol)).join("").trim();
  let result = "";
  for (const symbol of Array.from(text)) {
    if (result.length + symbol.length > LEDGER_LIMITS.maxLabelLength) break;
    result += symbol;
  }
  return result.trim();
}

/** Longest account name (Unicode code points); the name only labels the passkey in the OS picker. */
export const ACCOUNT_NAME_MAX = 64;
/** The account name as it will be used: NFC, invisible/bidi/control characters and lone surrogates removed, trimmed, never truncated. */
export function sanitizeAccountName(input: string): string {
  return Array.from(String(input).normalize("NFC")).filter(symbol => !stripped(symbol)).join("").trim();
}
/** True iff the sanitized name is non-empty and at most ACCOUNT_NAME_MAX code points. */
export function accountNameValid(input: string): boolean {
  const length = Array.from(sanitizeAccountName(input)).length;
  return length > 0 && length <= ACCOUNT_NAME_MAX;
}

type Membership = "member" | "revoked" | "conflict" | "absent";
/** Where this browser stands in a trust view: a member with these exact keys, revoked, a conflicting entry, or absent. */
function membership(trusted: LedgerCheckpoint, endpoint: EndpointPublic, authPublicKey: string): Membership {
  if (trusted.revokedDeviceIds.indexOf(endpoint.id) !== -1) return "revoked";
  const entry = trusted.devices.filter(item => item.endpoint.id === endpoint.id)[0];
  if (entry !== undefined) return entry.authPublicKey === authPublicKey && entry.endpoint.publicKey === endpoint.publicKey ? "member" : "conflict";
  const members: { endpoint: { publicKey: string }; authPublicKey: string }[] = [...trusted.devices, ...trusted.bridges];
  const keys = [endpoint.publicKey, authPublicKey];
  return members.some(item => keys.indexOf(item.endpoint.publicKey) !== -1 || keys.indexOf(item.authPublicKey) !== -1) ? "conflict" : "absent";
}

interface Base { ledger: Ledger; checkpoint: LedgerCheckpoint }
interface PendingCreation { handle: Uint8Array; credentialId: string; publicKey: string; label: string }
/**
 * `signed`: a creation's signed add_device, kept (in memory) until the account is created, so a refused POST is retried without
 * another passkey or signature.
 */
interface PendingEnrollment extends Base { credentialId: string; creating: boolean; signed?: Signed<LedgerTransition> }
interface PendingAuthority { accountId: string; credentialId: string; publicKey: string; label: string; consent: PasskeySignature | null }
interface Device { identity: EndpointIdentity; key: { publicKey: string; privateKey: CryptoKey } }
interface HttpResult { status: number; value: unknown; retryAfterMs?: number }
/** What the server held at its last recorded answer: the chain's head and revision and every id that chain revokes. */
interface ServerView { accountId: string; head: string; revision: number; revokedDeviceIds: string[]; revokedBridgeIds: string[] }
/** The snapshot's divergence, computed for this local head and this other chain (describeFork and both resolution plans). */
interface DivergenceView { localHead: string; source: LedgerSource; entry: DivergentChain; value: LedgerDivergence }
const NO_IDS = (): { deviceIds: string[]; bridgeIds: string[] } => ({ deviceIds: [], bridgeIds: [] });

export class LedgerClient {
  private readonly origin: string;
  private readonly rpId: string;
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  private value: LedgerClientSnapshot = {
    status: "signed_out", checkpoint: null, discarded: [], localOnly: { deviceIds: [], bridgeIds: [] }, signer: null, pending: "none",
  };
  private readonly listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  /** Refresh pacing (see refreshShared): the read in flight, when the last read started, and the one pending trailing read. */
  private refreshing: Promise<void> | null = null;
  private lastRefreshAt: number | null = null;
  private trailing: Promise<void> | null = null;
  /** The credential this device signed with in this page session. */
  private credentialId: string | null = null;
  private creation: PendingCreation | null = null;
  private enrollment: PendingEnrollment | null = null;
  private authority: PendingAuthority | null = null;
  /** This browser's keys for the account they were last loaded for (drives the device_revoked status). */
  private device: { accountId: string; endpoint: EndpointPublic; authPublicKey: string } | null = null;
  private readonly memoryAttempts = new Map<string, number>();
  private readonly random: () => number;
  /**
   * Re-offer state (see the header). `server`: the head and revocations of the bound account's chain the server last answered with
   * (a read, or a POST answer), recorded only after the replica judged that chain, so it never outranks the local chain (see
   * behind()), and only when that exchange was sent after the one recorded before (`serverSeq`, from `exchangeSeq`). Null: unknown.
   * `reoffering`: the one queued or running re-offer, `reofferRunning` while its body runs; `reofferAgain`: a trigger arrived
   * meanwhile; `reofferForced`: retryNow() asked for one attempt past the pair window and the backoff. `reofferPair`: the last pair
   * sent and when. `notBefore`: the backoff, the earliest time for the next unforced attempt (0: none). `retryTimer` and
   * `retryTimerAt`: the one scheduled automatic attempt. `retryAfterUntil`: a server Retry-After, honoured even by retryNow().
   * `warnedStep`: the largest backoff step already warned about. `exclusiveActive`: exclusive() tasks running now. `peeked`: this
   * browser's stored keys read by the re-offer when this page has not loaded them. On load `server` starts from the replica's
   * persisted confirmed state, so a reload still knows which removals the server lacks.
   */
  private server: ServerView | null = null;
  private exchangeSeq = 0;
  private serverSeq = 0;
  private reoffering: Promise<void> | null = null;
  private reofferRunning = false;
  private reofferAgain = false;
  private reofferForced = false;
  private exclusiveActive = 0;
  private reofferPair: { local: string; server: string; at: number } | null = null;
  private reofferFailures = 0;
  private notBefore = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimerAt: number | null = null;
  private retryAfterUntil = 0;
  private peeked: { accountId: string; endpoint: EndpointPublic; authPublicKey: string } | null = null;
  private warnedStep = 0;
  private disposed = false;
  /**
   * Write state (see the header). `lastConflict`: snapshot.lastConflict. `sending`: the pending record during its first POST (hidden
   * from the snapshot meanwhile). `settled`: what reconcilePending last decided about the record sendPending is sending. `divergenceView`:
   * snapshot.divergence, recomputed after every replica change. `hookDepth`: >0 while a beforeSign hook runs (learnChain then skips the
   * queue that write holds). `warnedInvalid`: invalid chains already warned about.
   */
  private lastConflict: LedgerWriteConflict | null = null;
  private sending: Signed<LedgerTransition> | null = null;
  private settled: { record: Signed<LedgerTransition>; result: Reconciled } | null = null;
  private divergenceView: DivergenceView | null = null;
  private otherCheckpoint: { head: string; checkpoint: LedgerCheckpoint } | null = null;
  private hookDepth = 0;
  private readonly warnedInvalid = new Set<string>();

  constructor(private readonly deps: LedgerClientDeps) {
    if (canonicalOrigin(deps.origin) !== deps.origin || deps.origin === "null") throw new Error("invalid_origin");
    if (typeof deps.rpId !== "string" || !deps.rpId) throw new Error("invalid_rp_id");
    this.origin = deps.origin;
    this.rpId = deps.rpId;
    this.now = deps.now ?? Date.now;
    this.fetcher = deps.fetchImpl ?? fetch;
    this.random = deps.random ?? Math.random;
  }

  snapshot = (): LedgerClientSnapshot => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Loads (and re-verifies) the replica once; later calls reuse it. A failed load can be retried. */
  load(): Promise<void> {
    if (this.loading === null) {
      this.loading = (async () => {
        requireSecureContext();
        await this.deps.replica.load();
        // Until a read in this page replaces it: what the server held at the last answer this profile confirmed.
        const raw = this.deps.replica.raw();
        const heads = this.deps.replica.heads();
        const confirmed = this.deps.replica.confirmed();
        if (this.server === null && this.serverSeq === 0 && raw !== null && heads !== null && confirmed !== null) {
          // A confirmed state of older code has no revision: it is the head's position in the local chain (unknown if absent).
          const revision = confirmed.revision ?? heads.lastIndexOf(confirmed.head);
          if (revision >= 0) {
            this.server = {
              accountId: raw.checkpoint.accountId, head: confirmed.head, revision, revokedDeviceIds: confirmed.revokedDeviceIds, revokedBridgeIds: confirmed.revokedBridgeIds,
            };
          }
        }
        await this.afterReplicaChange();
        this.publish();
        // A signed change a previous page left pending: the retry run reads the server first, then sends it.
        if (this.deps.replica.pendingWrite() !== null) void this.kick();
      })().catch(error => {
        this.loading = null;
        this.update({ ...this.value, status: "error", error: code(error) });
        throw coded(error);
      });
    }
    return this.loading;
  }

  // ---- Account creation: three gestures (create passkey, sign genesis, sign add_device). ----

  /** Gesture 1: creates the account passkey (user.id = a fresh 32-byte handle). */
  createAccountStart(input: { passkeyLabel: string; userName: string }): Promise<void> {
    return this.exclusive(async () => {
      this.requireCreationOrigin();
      if (!accountNameValid(input.userName)) throw new Error("invalid_account_name");
      await this.load();
      if (this.deps.replica.raw() !== null) throw new Error("ledger_other_account");
      // A signed genesis is pending: finish it (enrollThisDevice / retryCreateAccount) or forget() it; never mint a second passkey.
      if (this.enrollment !== null && this.enrollment.creating) throw new Error("account_creation_pending");
      const handle = crypto.getRandomValues(new Uint8Array(32));
      const created = await this.deps.passkey.createPasskey({
        rpId: this.rpId, rpName: RP_NAME, handle, userName: sanitizeAccountName(input.userName),
      });
      this.creation = { handle, credentialId: created.credentialId, publicKey: created.publicKey, label: sanitizeLabel(input.passkeyLabel) || "Passkey" };
      this.enrollment = null;
      this.publish();
    });
  }

  /**
   * Gesture 2: signs the genesis; nothing is sent until the first device is enrolled (the server requires one). */
  createAccountFinish(): Promise<void> {
    return this.exclusive(async () => {
      this.requireCreationOrigin();
      const creation = this.creation;
      if (creation === null) throw new Error("account_creation_not_started");
      // Taken after the creation ceremony returned: the authority is stamped with the genesis' own time.
      const createdAt = this.now();
      const genesis: LedgerGenesis = {
        type: "ftown_account_genesis", version: 2, rpId: this.rpId, origins: [this.origin], handle: b64url(creation.handle), createdAt,
        authority: { credentialId: creation.credentialId, publicKey: creation.publicKey, label: creation.label, addedAt: createdAt },
      };
      const signed = await this.deps.passkey.signLedgerRecord(genesis, { rpId: this.rpId, credentialId: creation.credentialId });
      const ledger: Ledger = { genesis: signed, transitions: [] };
      const checkpoint = await verifyLedger(ledger, this.now());
      this.creation = null;
      this.credentialId = creation.credentialId;
      this.enrollment = { ledger, checkpoint, credentialId: creation.credentialId, creating: true };
      this.publish();
    });
  }

  /**
   * After the creating POST was refused (e.g. 403 registration_closed, 503 server_full, 429 rate_limited) or failed (network): POSTs the SAME signed chain
   * again. No passkey prompt. The pending creation is dropped only on
   * success or forget().
   */
  retryCreateAccount(): Promise<void> {
    return this.exclusive(async () => {
      this.requireCreationOrigin();
      await this.load();
      const enrollment = this.enrollment;
      if (enrollment === null || !enrollment.creating || enrollment.signed === undefined) throw new Error("account_creation_not_started");
      const accountId = enrollment.checkpoint.accountId;
      const bound = this.deps.replica.raw();
      if (bound !== null && bound.checkpoint.accountId !== accountId) throw new Error("ledger_other_account");
      const device = await this.loadDevice(accountId);
      await this.postCreation(enrollment, enrollment.signed, accountId);
      await this.enrolled(enrollment, accountId, device);
    });
  }

  /** createAccountStart + createAccountFinish + enrollThisDevice. */
  async createAccount(input: { passkeyLabel: string; deviceLabel: string; userName: string }): Promise<void> {
    await this.createAccountStart({ passkeyLabel: input.passkeyLabel, userName: input.userName });
    await this.createAccountFinish();
    await this.enrollThisDevice({ deviceLabel: input.deviceLabel });
  }

  // ---- New browser: two gestures (identify the passkey, sign add_device). ----

  /**
   * Gesture 1: a passkey assertion over a local sign-in challenge, only to learn the account handle; then reads that account's ledger.
   * The chain must verify (authority consent included), carry that handle in its genesis, and list the credential as an authority.
   * Nothing is bound yet. Returns enrolled: true (and signs in) when this browser is already a trusted device of the account.
   */
  identifyAccount(): Promise<{ enrolled: boolean }> {
    return this.exclusive(async () => {
      await this.load();
      const bound = this.deps.replica.raw();
      const allowCredentialIds = bound === null ? undefined : bound.checkpoint.authorities.map(item => item.credentialId);
      const picked = await this.deps.passkey.identifyPasskey({ rpId: this.rpId, allowCredentialIds });
      if (!HANDLE.test(picked.handle)) throw new Error("ledger_other_account");
      if (bound !== null && picked.handle !== bound.ledger.genesis.payload.handle) throw new Error("ledger_other_account");
      const seq = this.nextExchange();
      const response = await this.request("GET", `/api/account/ledger?handle=${encodeURIComponent(picked.handle)}`);
      let base: Base;
      if (response.status === 404 && bound !== null) {
        base = bound;
      } else {
        const candidate = this.ledgerOf(response, "account_not_found");
        if (bound !== null) {
          const parsed = parseLedger(candidate);
          if (await accountIdOf(parsed.genesis.payload) !== bound.checkpoint.accountId) throw new Error("ledger_other_account");
          // A server read: a server behind this chain is brought forward once this flow released the queue (see kick()).
          await this.serverChain(candidate, bound.checkpoint.accountId, seq);
          const latest = this.deps.replica.raw();
          if (latest === null) throw new Error("ledger_replica_corrupt");
          base = latest;
        } else {
          const ledger = parseLedger(candidate);
          base = { ledger, checkpoint: await verifyLedger(ledger, this.now()) };
        }
      }
      this.checkIdentified(base, picked);
      this.credentialId = picked.credentialId;
      this.creation = null;
      this.enrollment = { ledger: base.ledger, checkpoint: base.checkpoint, credentialId: picked.credentialId, creating: false };
      const accountId = base.checkpoint.accountId;
      const device = await this.loadDevice(accountId);
      if (membership(this.trustedFor(base), device.identity.endpoint, device.key.publicKey) !== "member") {
        this.publish();
        return { enrolled: false };
      }
      if (bound === null) await this.offerToReplica(base.ledger, { bind: true, expectAccountId: accountId });
      this.enrollment = null;
      this.publish();
      if (!await this.proveSession(accountId, device)) throw new Error("sign_in_failed");
      return { enrolled: true };
    });
  }

  /**
   * Last gesture of account creation and of a new browser: re-bases on the newest head of the account, signs this browser's
   * add_device, stores the chain, signs in.
   */
  enrollThisDevice(input: { deviceLabel: string }): Promise<void> {
    return this.exclusive(async () => {
      await this.load();
      const enrollment = this.enrollment;
      if (enrollment === null) throw new Error("enrollment_not_started");
      const accountId = enrollment.checkpoint.accountId;
      const bound = this.deps.replica.raw();
      if (bound !== null && bound.checkpoint.accountId !== accountId) throw new Error("ledger_other_account");
      if (enrollment.creating && enrollment.signed !== undefined) {
        // The creating POST already failed once: send the same signed chain again, without another signature.
        const device = await this.loadDevice(accountId);
        await this.postCreation(enrollment, enrollment.signed, accountId);
        await this.enrolled(enrollment, accountId, device);
        return;
      }
      let base: Base = enrollment;
      if (bound !== null) {
        // A bound browser (new keys after a rotation): a user write like any other.
        await this.beginWrite(false);
        base = await this.prepared();
      } else if (!enrollment.creating) {
        base = await this.rebaseUnbound(enrollment);
      }
      if (!base.checkpoint.authorities.some(item => item.credentialId === enrollment.credentialId)) throw new Error("passkey_not_authority");
      const device = await this.loadDevice(accountId);
      const state = membership(this.trustedFor(base), device.identity.endpoint, device.key.publicKey);
      if (state === "revoked" || state === "conflict") {
        this.publish();
        throw new Error(state === "revoked" ? "ledger_device_revoked" : "device_key_conflict");
      }
      if (state === "absent") {
        const label = sanitizeLabel(input.deviceLabel) || "Browser";
        const signed = await this.signTransition(base, enrollment.credentialId, issuedAt => ({
          type: "add_device", device: { endpoint: device.identity.endpoint, authPublicKey: device.key.publicKey, label, approvedAt: issuedAt },
        }));
        if (enrollment.creating) {
          enrollment.signed = signed;
          await this.postCreation(enrollment, signed, accountId);
        } else if (bound !== null) {
          await this.sendNew(base, signed);
        } else {
          await this.submitUnbound(base.ledger, signed, accountId);
        }
      } else if (bound === null) {
        await this.offerToReplica(base.ledger, { bind: true, expectAccountId: accountId });
      }
      await this.enrolled(enrollment, accountId, device);
    });
  }

  /** The creating POST: server rejection reasons surface as their own client codes (see CREATION_REASONS). */
  private async postCreation(enrollment: PendingEnrollment, signed: Signed<LedgerTransition>, accountId: string): Promise<void> {
    await this.submitUnbound(enrollment.ledger, signed, accountId, true);
  }

  /** The enrollment is stored: drop the pending state and sign in. */
  private async enrolled(enrollment: PendingEnrollment, accountId: string, device: Device): Promise<void> {
    this.credentialId = enrollment.credentialId;
    if (this.enrollment === enrollment) this.enrollment = null;
    this.publish();
    if (!await this.proveSession(accountId, device)) throw new Error("sign_in_failed");
  }

  /** identifyAccount + enrollThisDevice (when not yet a member). */
  async signInNewDevice(input: { deviceLabel: string }): Promise<void> {
    const { enrolled } = await this.identifyAccount();
    if (!enrolled) await this.enrollThisDevice(input);
  }

  /** No gesture: when the replica lists this browser as a trusted device, proves its device key over a server nonce. */
  async signInKnownDevice(): Promise<boolean> {
    try {
      await this.load();
      if (this.deps.replica.raw() === null) return false;
      try {
        // A sign-in decision wants the current roster, not a deferred one.
        await this.refreshShared(true);
      } catch (error) {
        // Offline or a server without the account: the server re-checks the proof against its own ledger anyway.
        if (SOFT_REFRESH_ERRORS.indexOf(code(error)) === -1) throw error;
      }
      // The server checks the proof against its own chain: a server behind this one (even one missing this browser's own add_device)
      // is brought forward first. Never throws, never prompts.
      await this.reofferSettled();
      const trusted = this.deps.replica.trusted();
      if (trusted === null) return false;
      const device = await this.loadDevice(trusted.accountId);
      this.publish();
      if (membership(trusted, device.identity.endpoint, device.key.publicKey) !== "member") return false;
      return await this.proveSession(trusted.accountId, device);
    } catch (error) {
      throw coded(error);
    }
  }

  /**
   * For status device_revoked: asks the deps for a new ECDH endpoint and device auth key (a revoked endpoint id can never be re-added).
   * The account stays bound; the owner then runs signInNewDevice (identify + add_device) with the new keys.
   */
  rotateDeviceIdentity(): Promise<void> {
    return this.exclusive(async () => {
      await this.load();
      const raw = this.deps.replica.raw();
      const accountId = raw !== null ? raw.checkpoint.accountId : this.enrollment !== null ? this.enrollment.checkpoint.accountId : null;
      if (accountId === null) throw new Error("signed_out");
      await this.deps.resetDeviceIdentity(accountId);
      this.device = null;
      // The new keys are not a member until enrolled: nothing is re-offered for the old ones.
      this.resetReoffer();
      const fresh = await this.loadDevice(accountId);
      const trusted = this.deps.replica.trusted();
      if (trusted !== null && membership(trusted, fresh.identity.endpoint, fresh.key.publicKey) !== "absent") throw new Error("device_rotation_failed");
      this.publish();
    });
  }

  // ---- Ledger writes (one gesture each once the signing credential is known). ----

  /**
   * Refreshes, then signs `operation` on the replica's head with this session's credential and stores it on the server. A removal is
   * checked like revokeDevice/revokeBridge (the ledger itself would sign a removal of an unknown id as a tombstone).
   */
  append(operation: LedgerOperation): Promise<void> {
    return this.exclusive(() => this.appendNow(() => operation, { check: raw => memberCheck(raw.checkpoint, operation, "ledger_revoked") }));
  }
  /**
   * Validated against the RAW chain (not trusted()), before any prompt: an id revoked only on this browser (snapshot.localOnly) is
   * still on the chain and can be revoked there again. Error('device_not_found') / Error('bridge_not_found') otherwise.
   */
  revokeDevice(endpointId: string): Promise<void> {
    const operation: LedgerOperation = { type: "revoke_device", endpointId };
    return this.exclusive(() => this.appendNow(() => operation, { check: raw => memberCheck(raw.checkpoint, operation) }));
  }
  revokeBridge(bridgeId: string): Promise<void> {
    const operation: LedgerOperation = { type: "revoke_bridge", bridgeId };
    return this.exclusive(() => this.appendNow(() => operation, { check: raw => memberCheck(raw.checkpoint, operation) }));
  }

  /**
   * Optional separate gesture: learns which authority this device holds (needed only when the account has several).
   * append() runs it itself when needed.
   */
  selectPasskey(): Promise<void> {
    return this.exclusive(async () => {
      await this.load();
      const raw = this.deps.replica.raw();
      if (raw === null) throw new Error("signed_out");
      await this.identifySigner(raw);
      this.publish();
    });
  }

  /** Gesture 1: creates another passkey for this account (same handle; every current authority excluded so none is overwritten). */
  addAuthorityStart(input: { label: string; userName?: string }): Promise<void> {
    return this.exclusive(async () => {
      await this.load();
      const raw = this.deps.replica.raw();
      if (raw === null) throw new Error("signed_out");
      const genesis = raw.ledger.genesis.payload;
      const accountId = raw.checkpoint.accountId;
      const created = await this.deps.passkey.createPasskey({
        rpId: genesis.rpId, rpName: RP_NAME, handle: fromB64url(genesis.handle),
        userName: sanitizeLabel(input.userName ?? "") || `${RP_NAME} ${accountId.slice(0, 8)}`,
        excludeCredentialIds: raw.checkpoint.authorities.map(item => item.credentialId),
      });
      if (raw.checkpoint.authorities.some(item => item.credentialId === created.credentialId || item.publicKey === created.publicKey)) {
        throw new Error("passkey_already_registered");
      }
      this.authority = {
        accountId, credentialId: created.credentialId, publicKey: created.publicKey, label: sanitizeLabel(input.label) || "Passkey", consent: null,
      };
      this.publish();
    });
  }

  /** Gesture 2: the NEW passkey consents to joining this account (its assertion over authorityConsentChallenge). */
  addAuthorityConsent(): Promise<void> {
    return this.exclusive(async () => {
      const pending = this.authority;
      if (pending === null) throw new Error("authority_not_started");
      const raw = this.deps.replica.raw();
      if (raw === null || raw.checkpoint.accountId !== pending.accountId) throw new Error("ledger_other_account");
      const consent = await this.deps.passkey.signAuthorityConsent({
        accountId: pending.accountId, authority: { credentialId: pending.credentialId, publicKey: pending.publicKey }, rpId: raw.ledger.genesis.payload.rpId,
      });
      this.authority = { ...pending, consent };
      this.publish();
    });
  }

  /** Gesture 3: an existing authority signs add_authority for the passkey created and consented in the previous steps. */
  addAuthorityFinish(): Promise<void> {
    return this.exclusive(async () => {
      const pending = this.authority;
      if (pending === null) throw new Error("authority_not_started");
      const consent = pending.consent;
      if (consent === null) throw new Error("authority_consent_required");
      const raw = this.deps.replica.raw();
      if (raw === null || raw.checkpoint.accountId !== pending.accountId) throw new Error("ledger_other_account");
      await this.appendNow(issuedAt => ({
        type: "add_authority",
        authority: { credentialId: pending.credentialId, publicKey: pending.publicKey, label: pending.label, addedAt: issuedAt },
        consent,
      }));
      this.authority = null;
      this.publish();
    });
  }

  /** addAuthorityStart + addAuthorityConsent + addAuthorityFinish. */
  async addAuthority(label: string): Promise<void> {
    await this.addAuthorityStart({ label });
    await this.addAuthorityConsent();
    await this.addAuthorityFinish();
  }

  /**
   * Pairing approval. The owner TYPES the code the bridge printed; a wrong code blocks approval, and after 5 wrong codes the request
   * is refused (counted in attemptStorage, so a reload does not reset it). Then: add_bridge signed by the passkey, approval sealed to
   * the bridge, PUT to the mailbox.
   */
  approveBridge(fragment: string, typedCode: string): Promise<void> {
    return this.exclusive(async () => {
      requireSecureContext();
      const link = parsePairLink(fragment);
      const requestId = link.request.requestId;
      const attempts = this.attempts(requestId);
      if (attempts >= MAX_CODE_ATTEMPTS) throw new Error("pair_attempts_exceeded");
      if (this.now() >= link.request.expiresAt) throw new Error("pair_link_expired");
      const typed = String(typedCode).replace(/[\s-]/g, "");
      if (!/^[0-9]{6}$/.test(typed) || typed !== await pairComparisonCode(link.request)) {
        this.setAttempts(requestId, attempts + 1);
        throw new Error("pair_code_mismatch");
      }
      await this.load();
      if (this.deps.replica.raw() === null) throw new Error("signed_out");
      await this.refreshShared(true);
      const trusted = this.deps.replica.trusted();
      if (trusted === null) throw new Error("signed_out");
      const accountId = trusted.accountId;
      if (trusted.revokedBridgeIds.indexOf(link.request.bridgeId) !== -1) throw new Error("account_bridge_revoked");
      const expected = await bridgeFromPairRequest(link.request, accountId, 0);
      const existing = trusted.bridges.filter(item => item.bridgeId === expected.bridgeId)[0];
      if (existing === undefined) {
        await this.appendNow(issuedAt => bridgeFromPairRequest(link.request, accountId, issuedAt).then(bridge => ({ type: "add_bridge" as const, bridge })),
          { refreshed: true });
      } else if (existing.endpoint.id !== expected.endpoint.id || existing.authPublicKey !== expected.authPublicKey) {
        throw new Error("pair_bridge_conflict");
      }
      const raw = this.deps.replica.raw();
      if (raw === null) throw new Error("signed_out");
      const device = await this.loadDevice(accountId);
      const sealed = await sealPairApproval(link, raw.ledger, device.identity, this.now());
      const response = await this.request("PUT", `/api/pair/${encodeURIComponent(requestId)}`, { sealed });
      if (response.status === 401) throw new Error("unauthorized");
      if (response.status === 409) throw new Error("pair_mailbox_conflict");
      if (response.status === 413) throw new Error("pair_mailbox_too_large");
      if (response.status === 400) throw new Error("invalid_pair_link");
      if (response.status < 200 || response.status >= 300) throw new Error("server_unavailable");
      this.clearAttempts(requestId);
    });
  }

  // ---- Divergence. ----

  /**
   * The owner's choice between this browser's history ('mine') and the other one in snapshot.divergence ('theirs'). After a fresh read
   * (the newest copy of either history) and the beforeSign hook: every operation of the discarded branch the chosen one must carry
   * (resolutionPlan: removals and passkeys added there) is signed again on top of the chosen chain, one passkey prompt each (an added
   * passkey keeps its original consent), then the resolve_fork record (one more prompt), all in memory only. Then ONE POST of chosen +
   * carried records + resolution; the replica adopts the chain the server answers with through fork choice, so with 'theirs' nothing
   * is adopted before the server accepted it. A cancelled prompt or a failed request sends or keeps nothing: the divergence stays and
   * the action can start over. Throws no_divergence, resolution_outdated (the other side moved meanwhile; the divergence then shows its
   * newer chain), or a request error.
   */
  resolveDivergence(keep: "mine" | "theirs"): Promise<void> {
    return this.exclusive(async () => {
      if (keep !== "mine" && keep !== "theirs") throw new Error("invalid_request");
      await this.load();
      if (this.deps.replica.raw() === null) throw new Error("signed_out");
      this.lastConflict = null;
      await this.refreshShared(true);
      if (this.currentDivergence() === null) throw new Error("no_divergence");
      await this.runHook();
      const raw = this.deps.replica.raw();
      const entry = this.currentDivergence();
      if (raw === null) throw new Error("signed_out");
      if (entry === null) throw new Error("no_divergence");
      const accountId = raw.checkpoint.accountId;
      const [chosen, other] = keep === "mine" ? [raw.ledger, entry.ledger] : [entry.ledger, raw.ledger];
      const plan = await resolutionPlan(chosen, other);
      let checkpoint = keep === "mine" ? raw.checkpoint : await this.checkpointOf(chosen);
      // A side that cannot carry the other's records is refused before any prompt (snapshot.divergence says so already).
      const side = this.side(checkpoint, chosen, plan.carry);
      if (!side.canKeep) throw new Error(side.reason ?? "invalid_ledger");
      // Signed by a passkey that was an authority at the fork point: it is one on both branches.
      const shared: Ledger = { genesis: raw.ledger.genesis, transitions: raw.ledger.transitions.slice(0, plan.fork.revision) };
      const atFork = await verifyLedger(shared, Math.max(this.now(), ledgerLastIssuedAt(shared)));
      const credentialId = await this.signerAmong(raw, atFork.authorities.map(item => item.credentialId));
      const rpId = raw.ledger.genesis.payload.rpId;
      let growing = chosen;
      const records: Signed<LedgerTransition>[] = [];
      try {
        for (const operation of plan.carry) {
          const payload = nextTransition(checkpoint, credentialId, operation, this.now(), ledgerLastIssuedAt(growing));
          const signed = await this.deps.passkey.signLedgerRecord(payload, { rpId, credentialId });
          const next = appended(growing, [signed]);
          const step = await chooseLedger(growing, next, Math.max(this.now(), payload.issuedAt), { head: checkpoint.head, checkpoint });
          if (step.decision !== "adopt") throw new Error("ledger_rejected");
          records.push(signed);
          growing = next;
          checkpoint = step.checkpoint;
        }
        const payload = await resolveForkTransition(growing, other, credentialId, this.now(), { head: checkpoint.head, checkpoint });
        const signed = await this.deps.passkey.signLedgerRecord(payload, { rpId, credentialId });
        records.push(signed);
        growing = appended(growing, [signed]);
      } catch (error) {
        if (code(error) === "passkey_wrong_credential") this.credentialId = null;
        throw error;
      }
      this.credentialId = credentialId;
      const resolution = records[records.length - 1];
      // Checked here, never stored: the replica takes the resolution only from the server's answer.
      const verdict = await chooseLedger(raw.ledger, growing, Math.max(this.now(), resolution.payload.issuedAt), { head: raw.checkpoint.head, checkpoint: raw.checkpoint })
        .catch(() => null);
      if (verdict === null || verdict.decision !== "adopt") throw new Error("ledger_rejected");
      const server = this.server;
      try {
        await this.store(growing, accountId, true, false, server !== null && server.accountId === accountId ? server.head : undefined);
      } catch (error) {
        // The server's chain went through fork choice: the divergence now holds the newer other chain.
        if (error instanceof StoreError && error.answered && (error.message === "diverged" || error.message === "head_changed")) throw new Error("resolution_outdated");
        throw error;
      }
      if (!await holds(this.deps.replica.raw()?.ledger, resolution.payload.revision, await ledgerHead(resolution.payload))) throw new Error("ledger_not_stored");
    });
  }

  /**
   * A chain obtained from a bridge or browser of the account (no caller yet). The same fork choice as any other input, on the same queue
   * (at once while a beforeSign hook holds that queue): adopted when it strictly extends the local chain (a server behind it is then
   * brought forward by the re-offer), kept as the peer's divergent chain when it is a valid other history (the divergence state), ignored
   * when invalid (one console.warn), behind or the same. Returns its relation to the local chain ('diverged' also when it carried the
   * owner's resolution and was adopted: see snapshot.divergence), or 'invalid'.
   */
  learnChain(chain: Ledger, source: "peer"): Promise<LedgerRelation | "invalid"> {
    const run = async (): Promise<LedgerRelation | "invalid"> => {
      await this.load();
      const raw = this.deps.replica.raw();
      if (raw === null) throw new Error("signed_out");
      const result = await this.offerToReplica(chain, { expectAccountId: raw.checkpoint.accountId, source });
      if (result.decision === "reject" || result.relation === null) return "invalid";
      if (result.decision === "adopt" && this.needsSend()) void this.kick();
      return result.relation;
    };
    if (this.hookDepth > 0) return run().catch(error => { throw coded(error); });
    return this.exclusive(run);
  }

  // ---- Replication. ----

  /**
   * GET the bound account's ledger and offer it to the replica. No-op while signed out. Reads start at least 2 s apart: when idle the
   * read starts now; otherwise the call joins the one trailing read at the end of the window (deferred, never dropped) and resolves
   * with it. `force` skips the spacing but joins a read already in flight. A re-offer in flight is awaited first (so the read sees
   * it), and one the read causes (the server is behind the local chain, or a pending write can be sent) is awaited too; a re-offer
   * never throws.
   */
  async refresh(options: { force?: boolean } = {}): Promise<void> {
    try {
      await this.reofferSettled();
      await this.refreshShared(options.force === true);
      await this.reofferSettled();
    } catch (error) {
      throw coded(error);
    }
  }

  /**
   * A head announced by the relay. Refreshes (paced like refresh(): immediately when idle, else one trailing read at the end of the
   * window) unless it is the local RAW head (relateHead 'same'): another head may mean the server is ahead or diverged, an older head of
   * the local chain that it is behind (and the read then brings it forward, see refreshNow). Resolves once the read it caused, and a
   * re-offer that read caused, are done. Never throws: it is only a hint.
   */
  async noteHead(head: string, revision: number): Promise<void> {
    try {
      await this.load();
      const heads = this.deps.replica.heads();
      if (heads === null || typeof head !== "string" || !Number.isSafeInteger(revision) || revision < 0) return;
      let relation: "same" | "behind" | "unknown" = "unknown";
      // A malformed head is still a hint that something changed: the (paced) read decides.
      try { relation = relateHead(heads, { revision, head }); } catch { relation = "unknown"; }
      if (relation === "same") return;
      await this.refreshShared(false);
      await this.reofferSettled();
    } catch {
      // The next explicit refresh reports the failure.
    }
  }

  /**
   * A ledger pushed on `account:ledger#<accountId>`: a bare ledger, `{type:'ledger', ledger}`, or `{type:'ledger_head', head, revision}`
   * (see noteHead). Ignored while unbound (a push never selects the account). Fork choice decides: a chain that extends the local one is
   * adopted; one the local chain extends starts a paced read in the background (the server may be behind, or the message is old or
   * replayed); a valid different history is kept as the relay's divergent chain (the divergence state, nothing sent); an invalid or
   * foreign one is ignored (one console.warn). Resolves once the chain itself was offered.
   */
  async offer(candidate: unknown): Promise<void> {
    try {
      await this.load();
      const raw = this.deps.replica.raw();
      if (raw === null) return;
      if (isPlain(candidate) && candidate.type === "ledger_head") {
        await this.noteHead(String(candidate.head), Number(candidate.revision));
        return;
      }
      const pushed = isPlain(candidate) && candidate.type === "ledger" ? candidate.ledger : candidate;
      const result = await this.offerToReplica(pushed, { bind: false, expectAccountId: raw.checkpoint.accountId, source: "relay" });
      if (result.decision === "keep" && result.relation === "behind") {
        void this.refreshShared(false).then(() => this.reofferSettled()).catch(() => undefined);
      } else if (result.decision === "adopt" && this.needsSend()) {
        // A pushed extension moved the local chain past the server state on record: the run's own read tells what the server holds now.
        void this.kick();
      }
    } catch (error) {
      throw coded(error);
    }
  }

  /**
   * "Retry now": a fresh read, then one attempt (the pending write, else a re-offer) that skips the 30 s pair window and the backoff
   * wait once. Serialized with every other flow like any re-offer, never prompts, and still sends only the pending record on the head it
   * was signed on, or a chain the server's chain is a prefix of from a browser that may re-offer. A pending server Retry-After
   * (snapshot.retryNotBefore) is honoured: the call then resolves without any request, and the automatic retry runs when it ends. Calls
   * while one is pending share it. Resolves when that run is done; never throws.
   */
  retryNow(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.reofferForced = true;
    return this.kick();
  }

  /** Stops re-offers for good: the retry timer is cancelled and no later trigger sends anything. Every other method keeps working. */
  dispose(): void {
    this.disposed = true;
    this.resetReoffer();
  }

  /** Throws Error('account_bridge_revoked') unless `bridgeId` is a trusted (sticky-filtered) bridge with exactly that endpoint id. */
  assertBridgeAccess(bridgeId: string, endpointId: string): void {
    const trusted = this.deps.replica.trusted();
    if (trusted === null || !trusted.bridges.some(item => item.bridgeId === bridgeId && item.endpoint.id === endpointId)) {
      throw new Error("account_bridge_revoked");
    }
  }

  /** Clears the (persisted) discarded-records notice, and snapshot.lastConflict, after the UI showed them. */
  async dismissDiscarded(): Promise<void> {
    this.lastConflict = null;
    try {
      await this.deps.replica.dismissDiscarded();
    } finally {
      this.publish();
    }
  }

  /**
   * Forgets this browser's account binding, chain, discarded records, pending write and divergent chains, and every half-done flow (a
   * pending creation and its secret included). The account's sticky revocations are kept.
   */
  forget(): Promise<void> {
    return this.exclusive(async () => {
      this.resetReoffer();
      this.credentialId = null;
      this.creation = null;
      this.enrollment = null;
      this.authority = null;
      this.device = null;
      this.lastConflict = null;
      this.divergenceView = null;
      try {
        await this.deps.replica.clear();
      } finally {
        this.publish();
      }
    });
  }

  // ---- Internals. ----

  private requireCreationOrigin(): void {
    if (canonicalOrigin(this.deps.pageOrigin) !== this.origin || canonicalOrigin(this.deps.publicOrigin) !== this.origin) {
      throw new Error("origin_mismatch");
    }
  }

  /** The unbound new-browser rule: the verified chain's genesis carries the passkey's handle and lists the credential as an authority. */
  private checkIdentified(base: Base, picked: { credentialId: string; handle: string }): void {
    if (base.ledger.genesis.payload.handle !== picked.handle) throw new Error("ledger_other_account");
    if (!base.checkpoint.authorities.some(item => item.credentialId === picked.credentialId)) throw new Error("passkey_not_authority");
  }

  /** Unbound browser between its two gestures: a newer chain of the same account (by handle) replaces the pending base. */
  private async rebaseUnbound(base: Base): Promise<Base> {
    const response = await this.request("GET", `/api/account/ledger?handle=${encodeURIComponent(base.ledger.genesis.payload.handle)}`);
    if (response.status !== 200 || !isPlain(response.value)) return base;
    try {
      const candidate = parseLedger(response.value.ledger);
      const choice = await chooseLedger(base.ledger, candidate, this.now(), { head: base.checkpoint.head, checkpoint: base.checkpoint });
      return choice.decision === "adopt" ? { ledger: choice.ledger, checkpoint: choice.checkpoint } : base;
    } catch {
      return base;
    }
  }

  /** `check` runs on the refreshed RAW chain before any prompt; `refreshed` skips the (forced) refresh the caller just did. */
  private async appendNow(
    build: (issuedAt: number) => LedgerOperation | Promise<LedgerOperation>, options: { check?: (raw: Base) => void; refreshed?: boolean } = {},
  ): Promise<void> {
    await this.load();
    if (this.deps.replica.raw() === null) throw new Error("signed_out");
    // Never sign on a stale head: that would only be refused.
    await this.beginWrite(options.refreshed === true);
    const raw = await this.prepared();
    if (options.check !== undefined) options.check(raw);
    const credentialId = await this.signer(raw);
    let signed: Signed<LedgerTransition>;
    try {
      signed = await this.signTransition(raw, credentialId, build);
    } catch (error) {
      if (code(error) === "passkey_wrong_credential") this.credentialId = null;
      throw error;
    }
    await this.sendNew(raw, signed);
  }

  /**
   * The start of every bound user write, before any prompt: refused with ledger_diverged while a divergence holds and with write_pending
   * while another signed change waits for the server (after a fresh read, which may find it delivered); otherwise the fresh read
   * (`refreshed`: the caller just made it), which adopts a server chain that extends the local one.
   */
  private async beginWrite(refreshed: boolean): Promise<void> {
    this.requireNoDivergence();
    this.lastConflict = null;
    const waiting = this.deps.replica.pendingWrite() !== null;
    if (!refreshed) {
      try {
        await this.refreshShared(true);
      } catch (error) {
        // The read could not tell whether the waiting change was saved: it still blocks this one.
        if (waiting) throw new Error("write_pending");
        throw error;
      }
    }
    this.requireNoDivergence();
    if (this.deps.replica.pendingWrite() !== null) throw new Error("write_pending");
  }

  /**
   * After the fresh read: the beforeSign hook, then the base to build on, read again (the hook may have taught the replica a longer
   * chain). The server's chain must be known and the same as, or a prefix of, the local one; else ledger_invalid before any prompt.
   */
  private async prepared(): Promise<Base> {
    await this.runHook();
    this.requireNoDivergence();
    if (this.deps.replica.pendingWrite() !== null) throw new Error("write_pending");
    const raw = this.deps.replica.raw();
    if (raw === null) throw new Error("signed_out");
    const relation = this.serverRelation();
    if (relation !== "same" && relation !== "behind") throw new Error("ledger_invalid");
    return raw;
  }

  /** The beforeSign hook with the local head (learnChain runs at once while it does). */
  private async runHook(): Promise<void> {
    const raw = this.deps.replica.raw();
    if (raw === null) throw new Error("signed_out");
    this.hookDepth += 1;
    try {
      await this.beforeSign({ revision: raw.checkpoint.revision, head: raw.checkpoint.head });
    } finally {
      this.hookDepth -= 1;
    }
  }

  /** The point where an agreement step runs before a passkey prompt (deps.beforeSign by default); see LedgerClientDeps.beforeSign. */
  protected beforeSign(head: { revision: number; head: string }): Promise<void> {
    return this.deps.beforeSign === undefined ? Promise.resolve() : this.deps.beforeSign(head);
  }

  private requireNoDivergence(): void {
    if (this.diverged()) throw new Error("ledger_diverged");
  }

  /** Builds the next payload on the RAW checkpoint (issuedAt = max(now, last record), also the op's approvedAt/addedAt) and signs it. */
  private async signTransition(
    base: Base, credentialId: string, build: (issuedAt: number) => LedgerOperation | Promise<LedgerOperation>,
  ): Promise<Signed<LedgerTransition>> {
    const last = ledgerLastIssuedAt(base.ledger);
    const at = this.now();
    const operation = await build(Math.max(at, last));
    const payload = nextTransition(base.checkpoint, credentialId, operation, at, last);
    const signed = await this.deps.passkey.signLedgerRecord(payload, { rpId: base.ledger.genesis.payload.rpId, credentialId });
    // The authenticator proved it holds this credential: later writes need no identification prompt.
    this.credentialId = credentialId;
    return signed;
  }

  /**
   * A bound user write's signed record: checked on top of `base` (never stored in the replica), persisted as THE pending write (the
   * passkey was used: a reload must not lose it), then sent once (see sendPending). Resolves when the server's chain holds it and the
   * replica adopted that chain. Otherwise throws: write_conflict (another change landed first; the record went to discarded), ledger_diverged,
   * a definitive refusal (the record went to discarded), or the code of a refusal/failure after which it stays pending and is retried
   * by itself (network_unavailable, server_unavailable, rate_limited, head_changed, ledger_rejected, ledger_not_stored, account_not_found).
   * write_pending when another tab's signed change is pending already (this record then went to discarded, unsent).
   */
  private async sendNew(base: Base, record: Signed<LedgerTransition>): Promise<void> {
    const candidate = appended(base.ledger, [record]);
    const verdict = await chooseLedger(base.ledger, candidate, Math.max(this.now(), record.payload.issuedAt), { head: base.checkpoint.head, checkpoint: base.checkpoint })
      .catch(() => null);
    if (verdict === null || verdict.decision !== "adopt" || verdict.relation !== "ahead") throw new Error("ledger_rejected");
    if (!await this.deps.replica.setPendingWrite({ version: 1, record, since: this.now() }, null)) {
      await this.deps.replica.noteDiscarded([record]);
      this.publish();
      throw new Error("write_pending");
    }
    this.sending = record;
    let delivery: Delivery;
    try {
      delivery = await this.sendPending(record);
    } finally {
      this.sending = null;
      this.publish();
    }
    if (delivery.kind === "delivered") return;
    if (delivery.kind === "dropped") throw new Error(delivery.code);
    if (delivery.code !== "account_not_found") {
      // A refusal that carried the server's chain: the run that answer queued must not send the same pair straight back.
      if (delivery.answered) this.notePair(this.candidateKey());
      this.storeLater(delivery.retryAfterMs);
    }
    throw new Error(delivery.code);
  }

  /**
   * One POST of the local chain + the pending `record`, with `expectHead` the server head on record. Before it, and after the answer
   * (whose chain the replica judged), reconcilePending decides: delivered (the local chain holds it), dropped (the local chain moved past
   * its base: write_conflict; or a divergence holds: ledger_diverged), else still pending. A 400/403/413 drops it too (its code); every
   * other refusal or failure keeps it (`code`: what the user write reports; `answered`: a 409 that carried the server's chain).
   */
  private async sendPending(record: Signed<LedgerTransition>): Promise<Delivery> {
    try {
      return await this.sendPendingOnce(record);
    } finally {
      // The pending write or lastConflict may have changed without a replica change that published it.
      this.publish();
    }
  }
  private async sendPendingOnce(record: Signed<LedgerTransition>): Promise<Delivery> {
    const before = await this.reconcilePending();
    if (before !== "live") return before === "delivered" || before === "none" ? { kind: "delivered" } : { kind: "dropped", code: before };
    const raw = this.deps.replica.raw();
    const server = this.server;
    if (raw === null) return { kind: "dropped", code: "signed_out" };
    const accountId = raw.checkpoint.accountId;
    this.settled = { record, result: "live" };
    let kept: Delivery;
    try {
      await this.store(appended(raw.ledger, [record]), accountId, true, false, server !== null && server.accountId === accountId ? server.head : undefined);
      kept = { kind: "kept", code: "ledger_not_stored", answered: true };
    } catch (error) {
      if (error instanceof StoreError && error.status !== undefined && DEFINITIVE_STATUSES.indexOf(error.status) !== -1) {
        await this.dropPending(record, error.message);
        this.settled = null;
        return { kind: "dropped", code: error.message };
      }
      const reason = error instanceof StoreError ? error.message === "account_unknown" ? "account_not_found" : error.message === "diverged" ? "ledger_rejected" : error.message : code(error);
      kept = { kind: "kept", code: reason, retryAfterMs: error instanceof StoreError ? error.retryAfterMs : undefined, answered: error instanceof StoreError && error.answered };
    }
    const settled = this.settled;
    this.settled = null;
    const after = settled !== null && settled.record === record && settled.result !== "live" ? settled.result : await this.reconcilePending();
    if (after === "delivered" || after === "none") return { kind: "delivered" };
    if (after === "write_conflict" || after === "ledger_diverged") return { kind: "dropped", code: after };
    return kept;
  }

  /**
   * Brings the pending write in line with the local chain (after every replica change): 'delivered' when the local chain holds it (the
   * server took it, maybe through another tab), dropped as 'ledger_diverged' while a divergence holds or as 'write_conflict' when the
   * local chain is no longer the head it was signed on (another change landed first); else 'live'. A dropped record goes to discarded().
   */
  private async reconcilePending(): Promise<Reconciled> {
    const pending = this.deps.replica.pendingWrite();
    const raw = this.deps.replica.raw();
    if (pending === null || raw === null) return "none";
    const { record } = pending;
    let result: Reconciled = "live";
    if (await holds(raw.ledger, record.payload.revision, await ledgerHead(record.payload))) result = "delivered";
    else if (this.diverged()) result = "ledger_diverged";
    else if (raw.checkpoint.revision !== record.payload.revision - 1 || raw.checkpoint.head !== record.payload.previousHead) result = "write_conflict";
    if (result === "live") return result;
    if (this.settled !== null && this.settled.record.signature.signature === record.signature.signature) this.settled = { record: this.settled.record, result };
    if (result === "delivered") {
      await this.deps.replica.setPendingWrite(null, record).catch(() => false);
      this.settleReoffer();
    } else {
      await this.dropPending(record, result);
    }
    return result;
  }

  /** The pending write will never be sent: it is kept in discarded() (to sign again) and reported as snapshot.lastConflict. */
  private async dropPending(record: Signed<LedgerTransition>, reason: string): Promise<void> {
    await this.deps.replica.setPendingWrite(null, record).catch(() => false);
    await this.deps.replica.noteDiscarded([record]).catch(() => undefined);
    this.lastConflict = { ...targetOf(record.payload.operation), at: this.now(), reason };
  }

  /**
   * An unbound browser's first record (account creation, or a new browser's add_device): POSTed, and the replica binds to this own
   * chain only after the server accepted it; the server's answer is then offered like any other candidate (never binding). Throws
   * ledger_not_stored when the server's chain lacks the record.
   */
  private async submitUnbound(base: Ledger, record: Signed<LedgerTransition>, accountId: string, creating = false): Promise<void> {
    const value = await this.store(appended(base, [record]), accountId, false, creating);
    if (!await holds(value.ledger, record.payload.revision, await ledgerHead(record.payload))) throw new Error("ledger_not_stored");
  }

  /**
   * POST `chain` and read the answer: the one path of a write, a resolution and a re-offer. Any chain the server answers with (200/201,
   * or a 409 of a bound account) goes through the replica's fork choice and is recorded as the server's chain (see serverChain).
   * `expectHead`: the server head just read (every bound POST); the server then never creates the account (404 account_unknown) and
   * refuses when its head moved (409 head_changed, with its chain). Returns the answer body; throws StoreError: a creation reason
   * (CREATION_REASONS, `creating` only), registration_closed, account_unknown, head_changed, diverged (409: the server holds a valid
   * history this chain does not extend), ledger_rejected, ledger_limit, rate_limited (429 rate_limited, with its Retry-After),
   * server_unavailable; or a request error.
   */
  private async store(chain: Ledger, accountId: string, wasBound: boolean, creating = false, expectHead?: string): Promise<Record<string, unknown>> {
    const seq = this.nextExchange();
    const response = await this.request("POST", "/api/account/ledger", expectHead === undefined ? { ledger: chain } : { ledger: chain, expectHead });
    const value = isPlain(response.value) ? response.value : {};
    const status = response.status;
    if (creating && status !== 200 && status !== 201 && typeof value.error === "string" && CREATION_REASONS.indexOf(value.error) !== -1) {
      throw new StoreError(value.error, response.retryAfterMs, false, status);
    }
    if (status === 403) throw new StoreError(value.error === "registration_closed" ? "registration_closed" : "ledger_rejected", undefined, false, status);
    if (status === 404 && value.error === "account_unknown") {
      this.serverGone(seq);
      throw new StoreError("account_unknown", undefined, false, status);
    }
    if (status === 409) {
      const answered = wasBound && value.ledger !== null && value.ledger !== undefined;
      if (answered) await this.serverChain(value.ledger, accountId, seq);
      const reason = value.error === "head_changed" ? "head_changed" : value.error === "diverged" ? "diverged" : "ledger_rejected";
      throw new StoreError(reason, undefined, answered, status);
    }
    if (status === 413) throw new StoreError("ledger_limit", undefined, false, status);
    // A per-account write limit: a pending record stays pending and is sent again later.
    if (status === 429 && value.error === "rate_limited") throw new StoreError("rate_limited", response.retryAfterMs, false, status);
    if (status !== 200 && status !== 201) {
      throw new StoreError(status === 429 || status >= 500 ? "server_unavailable" : "ledger_rejected", response.retryAfterMs, false, status);
    }
    if (!wasBound && (await this.offerToReplica(chain, { bind: true, expectAccountId: accountId })).decision !== "adopt") throw new StoreError("ledger_rejected");
    await this.serverChain(value.ledger, accountId, seq, true);
    return value;
  }

  /** A sequence number for a server exchange, taken when it is sent: answers are recorded only in this order (see serverChain). */
  private nextExchange(): number {
    this.exchangeSeq += 1;
    return this.exchangeSeq;
  }

  /**
   * A chain the server answered with in exchange `seq`: offered to the replica (fork choice: adopted when it extends the local chain,
   * kept as the server's divergent chain when it is a valid other history, ignored with a warning when invalid), then recorded with its
   * head, revision and revocation ids unless a later-sent exchange was recorded already (and persisted with the replica as the confirmed
   * server state), then the pending write and the divergence are brought in line and the snapshot published; see `server` and behind().
   * Queues a run when something is to be sent (a pending write, or a server behind the local chain); nothing while diverged.
   * `posted`: the 200/201 answer to a POST, the only "current" that resets the backoff (see settleReoffer).
   */
  private async serverChain(candidate: unknown, accountId: string, seq: number, posted = false): Promise<void> {
    // Published once below, after the server state is recorded, so no snapshot pairs the new chain with the old server state.
    const { decision } = await this.deps.replica.offer(candidate, { expectAccountId: accountId, source: "server" });
    if (decision === "reject") await this.warnInvalid("server", candidate);
    let view: ServerView | null = null;
    if (decision !== "reject") {
      try {
        const parsed = parseLedger(candidate);
        const revoked = ledgerRevocations(parsed);
        view = {
          accountId, head: await this.headOf(candidate), revision: parsed.transitions.length, revokedDeviceIds: revoked.deviceIds, revokedBridgeIds: revoked.bridgeIds,
        };
      } catch {
        view = null;
      }
    }
    // Synchronous from here: no other answer can be recorded between the order check and the write (the persisting write is queued
    // in the same order, so the last one stored is the last one recorded).
    let persisted: Promise<void> | null = null;
    if (seq > this.serverSeq) {
      this.serverSeq = seq;
      const raw = this.deps.replica.raw();
      this.server = view !== null && raw !== null && raw.checkpoint.accountId === accountId ? view : null;
      // A chain the replica refused is not a confirmed state: the last confirmed one stays stored.
      if (this.server !== null) persisted = this.persistServer(this.server);
    }
    if (persisted !== null) await persisted;
    await this.afterReplicaChange();
    this.publish();
    // Every trigger lands here; a run is needed only for something to send (one queued behind whatever holds the queue now).
    if (this.diverged()) this.stopTimer();
    else if (this.needsSend()) void this.kick();
    else if (this.converged()) {
      if (posted) this.settleReoffer();
      else this.stopTimer();
    }
  }

  /** The server answered exchange `seq` without the account: its state is unknown from now on (nothing is re-offered to it). */
  private serverGone(seq: number): void {
    if (seq <= this.serverSeq) return;
    this.serverSeq = seq;
    this.server = null;
    void this.persistServer(null);
    this.publish();
  }

  /** Stores the confirmed server state with the replica (null: none); a failed write only loses what a reload would know. */
  private persistServer(view: ServerView | null): Promise<void> {
    const confirmed = view === null ? null
      : { version: 1 as const, head: view.head, revision: view.revision, revokedDeviceIds: view.revokedDeviceIds, revokedBridgeIds: view.revokedBridgeIds };
    return this.deps.replica.noteConfirmed(confirmed).catch(() => undefined);
  }

  /** The head of a chain: its last record's, or its genesis' (the accountId) when it has none. Throws on a malformed chain. */
  private async headOf(candidate: unknown): Promise<string> {
    const ledger = parseLedger(candidate);
    const last = ledger.transitions[ledger.transitions.length - 1];
    return ledgerHead(last === undefined ? ledger.genesis.payload : last.payload);
  }

  /** The replica took or judged a chain: the pending write and the divergence view follow it. */
  private async afterReplicaChange(): Promise<void> {
    await this.reconcilePending();
    await this.refreshDivergenceView();
  }

  /** Offers a chain to the replica (warning once about an invalid one from a source), then follows it up like any replica change. */
  private async offerToReplica(candidate: unknown, options: ReplicaOfferOptions): Promise<ReplicaOffer> {
    const result = await this.deps.replica.offer(candidate, options);
    if (result.decision === "reject" && options.source !== undefined) await this.warnInvalid(options.source, candidate);
    await this.afterReplicaChange();
    this.publish();
    return result;
  }

  /** One console.warn per distinct invalid chain and source: such a chain is ignored like silence. */
  private async warnInvalid(source: LedgerSource, candidate: unknown): Promise<void> {
    let key: string;
    try {
      key = `${source}:${await this.headOf(candidate)}`;
    } catch {
      key = `${source}:malformed`;
    }
    if (this.warnedInvalid.has(key)) return;
    if (this.warnedInvalid.size >= MAX_WARNED_INVALID) this.warnedInvalid.clear();
    this.warnedInvalid.add(key);
    console.warn(`[ledger] ignored an invalid chain from ${source}`);
  }

  /** True while the replica holds a valid different history (any source). */
  private diverged(): boolean {
    return Object.keys(this.deps.replica.divergence()).length > 0;
  }
  /** The divergent chain the snapshot shows and resolveDivergence resolves: the server's first, then a peer's, then the relay's. */
  private currentDivergence(): (DivergentChain & { source: LedgerSource }) | null {
    const chains = this.deps.replica.divergence();
    for (const source of DIVERGENCE_ORDER) {
      const entry = chains[source];
      if (entry !== undefined) return { ...entry, source };
    }
    return null;
  }
  /** Recomputes snapshot.divergence when the local head or the shown divergent chain changed (describeFork, both resolution plans). */
  private async refreshDivergenceView(): Promise<void> {
    const raw = this.deps.replica.raw();
    const entry = this.currentDivergence();
    if (raw === null || entry === null) {
      this.divergenceView = null;
      return;
    }
    const known = this.divergenceView;
    if (known !== null && known.localHead === raw.checkpoint.head && known.source === entry.source && known.entry.ledger === entry.ledger) return;
    try {
      const [fork, mine, theirs, other] = await Promise.all([
        describeFork(raw.ledger, entry.ledger), resolutionPlan(raw.ledger, entry.ledger), resolutionPlan(entry.ledger, raw.ledger), this.checkpointOf(entry.ledger),
      ]);
      this.divergenceView = {
        localHead: raw.checkpoint.head, source: entry.source, entry,
        value: {
          other: entry.ledger, source: entry.source, fork, firstSeen: entry.firstSeen,
          mine: this.side(raw.checkpoint, raw.ledger, mine.carry), theirs: this.side(other, entry.ledger, theirs.carry),
        },
      };
    } catch {
      this.divergenceView = null;
    }
  }
  /** The RAW checkpoint of a divergent chain (verified once per chain tip; the replica verified it already when it kept the chain). */
  private async checkpointOf(ledger: Ledger): Promise<LedgerCheckpoint> {
    const head = await this.headOf(ledger);
    const known = this.otherCheckpoint;
    if (known !== null && known.head === head) return known.checkpoint;
    const checkpoint = await verifyLedger(ledger, Math.max(this.now(), ledgerLastIssuedAt(ledger)));
    this.otherCheckpoint = { head, checkpoint };
    return checkpoint;
  }
  /**
   * Whether keeping the chain (checkpoint `checkpoint`) can carry `carry`: the passkey and record limits for all of them, and each record
   * built on it alone (nextTransition, no signature; signed by the genesis passkey, an authority at every fork point). A record that only
   * fails because of one carried before it is caught by the limits checked here or, at worst, when resolveDivergence builds it.
   */
  private side(checkpoint: LedgerCheckpoint, ledger: Ledger, carry: LedgerOperation[]): LedgerDivergenceSide {
    const added = carry.filter(item => item.type === "add_authority").length;
    if (checkpoint.authorities.length + added > LEDGER_LIMITS.maxAuthorities || checkpoint.revision + carry.length + 1 > LEDGER_LIMITS.maxTransitions) {
      return { carry, canKeep: false, reason: "ledger_limit" };
    }
    const signer = ledger.genesis.payload.authority.credentialId;
    for (const operation of carry) {
      try {
        nextTransition(checkpoint, signer, operation, Math.max(this.now(), ledgerLastIssuedAt(ledger)), ledgerLastIssuedAt(ledger));
      } catch (error) {
        return { carry, canKeep: false, reason: code(error) };
      }
    }
    return { carry, canKeep: true, reason: null };
  }

  // ---- Re-offer and the pending write's retries (see the header). ----

  /** The server's chain on record relative to the local one: 'same', 'behind' (a prefix), 'unknown' (diverged), or null when none is known. */
  private serverRelation(): "same" | "behind" | "unknown" | null {
    const raw = this.deps.replica.raw();
    const heads = this.deps.replica.heads();
    const server = this.server;
    if (raw === null || heads === null || server === null || server.accountId !== raw.checkpoint.accountId) return null;
    try {
      return relateHead(heads, { revision: server.revision, head: server.head });
    } catch {
      return "unknown";
    }
  }
  /** True iff the server's chain on record is a strict prefix of the local chain: the local records after it are to be re-offered. */
  private behind(): boolean {
    return this.serverRelation() === "behind";
  }
  /** True iff the server's chain on record is the local chain. */
  private converged(): boolean {
    return this.serverRelation() === "same";
  }
  /** The pending write, while the local chain is still the head it was signed on (else reconcilePending drops or settles it). */
  private livePending(): PendingWriteRecord | null {
    const pending = this.deps.replica.pendingWrite();
    const raw = this.deps.replica.raw();
    if (pending === null || raw === null) return null;
    const payload = pending.record.payload;
    return raw.checkpoint.revision === payload.revision - 1 && raw.checkpoint.head === payload.previousHead ? pending : null;
  }
  /** Something to send: the pending write, or local records the server lacks; never while diverged. */
  private needsSend(): boolean {
    return !this.diverged() && (this.livePending() !== null || this.behind());
  }
  /** What a run would send now, as the pair-window key: the pending record, else the local head. */
  private candidateKey(): string {
    const pending = this.livePending();
    if (pending !== null) return `pending:${pending.record.signature.signature}`;
    return this.deps.replica.raw()?.checkpoint.head ?? "";
  }

  /**
   * For the public calls that trigger re-offers (refresh, noteHead, signInKnownDevice): resolves when the re-offer run that is
   * running now (or about to start, nothing else holding the queue) is done, and after REQUEST_TIMEOUT_MS at most. A run queued
   * behind another flow (a passkey prompt can stay open for minutes) is not waited for: it finishes in the background.
   */
  private reofferSettled(): Promise<void> {
    const run = this.reoffering;
    if (run === null || (!this.reofferRunning && this.exclusiveActive > 0)) return Promise.resolve();
    return new Promise<void>(resolve => {
      const timer = setTimeout(resolve, REQUEST_TIMEOUT_MS);
      void run.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Starts the one re-offer run on the exclusive() queue, or marks the queued/running one to look again when it is done. Returns that
   * run (it never rejects). Never awaited from inside an exclusive() task (the run would wait for that task).
   */
  private kick(): Promise<void> {
    this.reofferAgain = true;
    if (this.reoffering === null && !this.disposed) {
      const run: Promise<void> = this.exclusive(async () => {
        this.reofferRunning = true;
        try {
          while (this.reofferAgain && !this.disposed) {
            this.reofferAgain = false;
            await this.reofferOnce();
          }
        } finally {
          this.reofferRunning = false;
        }
      }).catch(() => undefined).then(() => {
        if (this.reoffering === run) this.reoffering = null;
        // A trigger that arrived after the loop's last look.
        if (this.reofferAgain && !this.disposed) return this.kick();
        return undefined;
      });
      this.reoffering = run;
    }
    return this.reoffering ?? Promise.resolve();
  }

  /**
   * One decision, and at most two POSTs (the second only after a head_changed answer). Never throws. What is sent: the pending write
   * (local chain + its record) while the local chain is the head it was signed on, else the local chain while the server is behind it.
   * 1. On what is known: send nothing unless there is something to send (never while diverged), this browser may send it (a re-offer
   *    needs canReoffer; the pending write only a bound, non-creating client), and neither the pair window nor the backoff blocks
   *    (retryNow skips those two once, never a server Retry-After); a blocked attempt arms the timer for when it is due.
   * 2. A fresh read through refreshNow (fork choice, the server state recorded, the pending write reconciled: delivered, or dropped as
   *    write_conflict when the server moved on). 404: the account is gone, stop and reset the backoff. Any other failure backs off.
   * 3. On the fresh state, the same checks again, the pair window and backoff for the pair that read returned included; then POST
   *    with expectHead. The pending write: delivered -> done; dropped -> stop (snapshot.lastConflict); kept -> after head_changed one
   *    immediate re-evaluation, otherwise back off. A re-offer refused with the server's chain (fork choice ran on it): stop when
   *    diverged or no longer behind; after head_changed, one immediate re-evaluation; otherwise back off. account_unknown backs off
   *    too (the counter is reset only by a read's 404 and by a POST the server took).
   */
  private async reofferOnce(): Promise<void> {
    const forced = this.reofferForced;
    this.reofferForced = false;
    const known = this.deps.replica.raw();
    if (known === null) {
      this.stopTimer();
      return;
    }
    // A server Retry-After holds even for retryNow(): nothing is sent before it (the timer is due no sooner).
    if (forced && this.retryAfterPending()) return;
    if (!await this.mayAttempt(known.checkpoint.accountId, !forced)) return;
    try {
      await this.refreshNow();
    } catch (error) {
      if (code(error) === "account_not_found") {
        this.settleReoffer();
        return;
      }
      this.reofferFailed(code(error), error instanceof StoreError ? error.retryAfterMs : undefined);
      return;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = this.deps.replica.raw();
      const server = this.server;
      if (raw === null || server === null || !await this.mayAttempt(raw.checkpoint.accountId, !forced || attempt > 0)) return;
      const pending = this.livePending();
      if (pending !== null) {
        const relation = this.serverRelation();
        if (relation !== "same" && relation !== "behind") {
          this.stopTimer();
          return;
        }
        this.reofferPair = { local: this.candidateKey(), server: server.head, at: this.now() };
        const delivery = await this.sendPending(pending.record);
        if (delivery.kind === "delivered") {
          this.settleReoffer();
          return;
        }
        if (delivery.kind === "dropped") {
          this.stopTimer();
          return;
        }
        if (delivery.code === "head_changed" && attempt === 0 && this.livePending() !== null) continue;
        this.reofferFailed(delivery.code, delivery.retryAfterMs, this.needsSend());
        return;
      }
      this.reofferPair = { local: raw.checkpoint.head, server: server.head, at: this.now() };
      try {
        // The bound account's own chain, nothing else: public by design, already signed, so no prompt.
        await this.store(raw.ledger, raw.checkpoint.accountId, true, false, server.head);
      } catch (error) {
        if (error instanceof StoreError && error.answered) {
          // The answer's chain went through serverChain(): fork choice ran on it and its revocations are recorded.
          if (this.diverged()) {
            this.stopTimer();
            return;
          }
          if (!this.behind()) {
            // Nothing left to send (the server's chain won, or it claims ours), yet it refused: that still counts for the backoff.
            this.reofferFailed(error.message, undefined, false);
            return;
          }
          if (error.message === "head_changed" && attempt === 0) continue;
          this.reofferFailed(error.message, undefined);
          return;
        }
        this.reofferFailed(code(error), error instanceof StoreError ? error.retryAfterMs : undefined);
        return;
      }
      // store() recorded the server's answer; still behind means the server did not take this chain.
      if (this.behind()) this.reofferFailed("ledger_not_stored", undefined);
      else this.settleReoffer();
      return;
    }
  }

  /**
   * The checks before any request and again before the POST: something to send (never while diverged), this browser may send it (the
   * pending write: bound and not creating; a re-offer: canReoffer), and (when `paced`) due for the current pair. Stops the timer when
   * there is nothing to do, re-arms it when the attempt is only early.
   */
  private async mayAttempt(accountId: string, paced: boolean): Promise<boolean> {
    const allowed = this.livePending() !== null ? this.mayDeliver() : await this.mayReoffer(accountId);
    if (!this.needsSend() || !allowed) {
      this.stopTimer();
      return false;
    }
    const due = this.dueAt();
    if (paced && this.now() < due) {
      this.arm(due);
      return false;
    }
    return true;
  }
  /** The pending write is a passkey-signed record: any bound, non-creating client may deliver it, whatever its own keys. */
  private mayDeliver(): boolean {
    return !this.disposed && this.creation === null && !(this.enrollment !== null && this.enrollment.creating) && this.deps.replica.raw() !== null;
  }

  /** When the next attempt for the current (candidate, server) pair may run: the later of the pair window and the backoff. */
  private dueAt(): number {
    const raw = this.deps.replica.raw();
    const server = this.server;
    const now = this.now();
    const pair = this.reofferPair;
    const repeatAt = raw !== null && server !== null && pair !== null && pair.local === this.candidateKey() && pair.server === server.head && now >= pair.at
      ? pair.at + REOFFER_PAIR_MS : 0;
    // A time far beyond any delay this client sets means the clock went back: it is due.
    const notBefore = this.notBefore - now > MAX_RETRY_AFTER_MS ? 0 : this.notBefore;
    return Math.max(notBefore, repeatAt);
  }
  /** True while a server Retry-After has not elapsed (a clock gone back far past it does not count). */
  private retryAfterPending(): boolean {
    const left = this.retryAfterUntil - this.now();
    return left > 0 && left <= MAX_RETRY_AFTER_MS;
  }

  /** The current pair was just answered with a refusal (a user write): the retry waits out the pair window before sending it. */
  private notePair(candidate: string): void {
    const server = this.server;
    if (server !== null) this.reofferPair = { local: candidate, server: server.head, at: this.now() };
  }

  /**
   * Removals the server still lacks: the visible pending write's target when it is a removal, plus the ids the local chain revokes and
   * the server's chain on record does not while the server is known to be behind.
   */
  private unsavedIds(pending: LedgerPendingWrite | null): { deviceIds: string[]; bridgeIds: string[] } {
    const raw = this.deps.replica.raw();
    const ids = NO_IDS();
    if (raw !== null && this.behind()) {
      // behind() holds, so the server state is known.
      const server = this.server as ServerView;
      ids.deviceIds = raw.checkpoint.revokedDeviceIds.filter(id => server.revokedDeviceIds.indexOf(id) === -1);
      ids.bridgeIds = raw.checkpoint.revokedBridgeIds.filter(id => server.revokedBridgeIds.indexOf(id) === -1);
    }
    if (pending !== null && pending.operation === "revoke_device" && pending.deviceId !== undefined && ids.deviceIds.indexOf(pending.deviceId) === -1) ids.deviceIds.push(pending.deviceId);
    if (pending !== null && pending.operation === "revoke_bridge" && pending.bridgeId !== undefined && ids.bridgeIds.indexOf(pending.bridgeId) === -1) ids.bridgeIds.push(pending.bridgeId);
    return ids;
  }

  /** snapshot.pendingWrite: the replica's pending write, unless it is the record whose first request is in flight. */
  private visiblePending(): LedgerPendingWrite | null {
    const pending = this.deps.replica.pendingWrite();
    if (pending === null || (this.sending !== null && this.sending.signature.signature === pending.record.signature.signature)) return null;
    return { ...targetOf(pending.record.payload.operation), since: pending.since };
  }

  /** Reads this browser's stored keys when this page has not loaded them (read only: the snapshot status keeps using this.device). */
  private async mayReoffer(accountId: string): Promise<boolean> {
    if (this.ownKeys(accountId) === null) {
      try {
        const identity = await this.deps.endpoint(accountId);
        if (identity.endpoint.ownerId !== accountId || identity.endpoint.kind !== "browser") return false;
        this.peeked = { accountId, endpoint: identity.endpoint, authPublicKey: (await this.deps.deviceKey()).publicKey };
      } catch {
        return false;
      }
      // snapshot.canReoffer now knows the keys.
      this.publish();
    }
    return this.canReoffer(this.value.status);
  }
  private ownKeys(accountId: string): { endpoint: EndpointPublic; authPublicKey: string } | null {
    if (this.device !== null && this.device.accountId === accountId) return this.device;
    return this.peeked !== null && this.peeked.accountId === accountId ? this.peeked : null;
  }
  /**
   * Whether this browser may re-offer its chain: bound, signed in (status ready or device_revoked), not creating an account, and its
   * own keys either a trusted device or revoked by the local RAW chain itself (a self-removal: delivering that chain is the point).
   * Never when its keys are revoked only by the sticky set, replaced, or not enrolled. (Sticky-only revocations are no longer created:
   * a resolve_fork must carry the other branch's removals, and kept candidates add nothing; they remain in replicas of older code,
   * which is why this case stays.) Keys not read yet count by the status; the run reads them before sending.
   */
  private canReoffer(status: LedgerClientSnapshot["status"]): boolean {
    if (this.disposed || this.creation !== null || (this.enrollment !== null && this.enrollment.creating)) return false;
    if (status !== "ready" && status !== "device_revoked") return false;
    const raw = this.deps.replica.raw();
    const trusted = this.deps.replica.trusted();
    if (raw === null || trusted === null || trusted.accountId !== raw.checkpoint.accountId) return false;
    const own = this.ownKeys(raw.checkpoint.accountId);
    if (own === null) return status === "ready";
    if (membership(trusted, own.endpoint, own.authPublicKey) === "member") return true;
    return raw.checkpoint.revokedDeviceIds.indexOf(own.endpoint.id) !== -1;
  }

  /**
   * A bound user write's first POST failed or was refused and its record stays pending: retry without a prompt, after the jittered
   * backoff floor or the server's Retry-After, whichever is later (a Retry-After of 0 or in the past does not mean "now").
   */
  private storeLater(retryAfter: number | undefined): void {
    if (this.disposed) return;
    this.noteRetryAfter(retryAfter);
    const delay = Math.max(retryAfter ?? 0, this.jittered(this.backoffStep(Math.max(1, this.reofferFailures))));
    this.notBefore = Math.max(this.notBefore, this.now() + delay);
    this.arm(this.notBefore);
  }

  /** One more failure: the backoff grows; `schedule`: also arm the timer (false when nothing is left to send right now). */
  private reofferFailed(reason: string, retryAfterMs: number | undefined, schedule = true): void {
    this.reofferFailures += 1;
    this.noteRetryAfter(retryAfterMs);
    const step = this.backoffStep(this.reofferFailures);
    const delay = Math.max(retryAfterMs ?? 0, this.jittered(step));
    this.notBefore = this.now() + delay;
    if (step > this.warnedStep) {
      this.warnedStep = step;
      const what = this.livePending() !== null ? "a signed change is not saved on the server yet" : "the server's copy of the account ledger is behind";
      console.warn(`[ledger] ${what}; sending it failed (${reason}), next try in ${Math.round(delay / 1000)} s`);
    }
    if (schedule) this.arm(this.notBefore);
    else this.stopTimer();
  }
  /** Published with the timer that arm() sets right after. */
  private noteRetryAfter(retryAfterMs: number | undefined): void {
    if (retryAfterMs !== undefined && retryAfterMs > 0) this.retryAfterUntil = Math.max(this.retryAfterUntil, this.now() + retryAfterMs);
  }

  /** 30 s for the first failure, doubling, at most 10 min. */
  private backoffStep(failures: number): number {
    return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
  }
  private jittered(ms: number): number {
    const unit = Math.min(1, Math.max(0, this.random()));
    return Math.round(ms * (1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * unit));
  }

  /** The one retry timer, due at `at` (published as snapshot.retryAt). */
  private arm(at: number): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.disposed) {
      this.setRetryTimerAt(null);
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.setRetryTimerAt(null);
      void this.kick();
    }, Math.max(0, at - this.now()));
    this.setRetryTimerAt(at);
  }
  /** No automatic attempt scheduled; the backoff (notBefore) still holds for the next trigger. */
  private stopTimer(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.setRetryTimerAt(null);
  }
  private setRetryTimerAt(at: number | null): void {
    if (this.retryTimerAt === at) return;
    this.retryTimerAt = at;
    this.publish();
  }
  /**
   * The server took a POST and holds the local chain, or a read found the account gone: nothing pending, the backoff and any
   * Retry-After start over. (A read that finds the server current only stops the timer: a server answering "current" to some reads
   * and "behind" to others cannot reset the backoff.)
   */
  private settleReoffer(): void {
    this.stopTimer();
    const published = this.retryAfterUntil !== 0;
    this.notBefore = 0;
    this.retryAfterUntil = 0;
    this.reofferFailures = 0;
    this.warnedStep = 0;
    if (published) this.publish();
  }
  /** Sign-out, a device rotation or dispose(): forget everything the re-offer knew. A run already queued finds nothing to send. */
  private resetReoffer(): void {
    this.settleReoffer();
    this.server = null;
    this.peeked = null;
    this.reofferPair = null;
    this.reofferAgain = false;
    this.reofferForced = false;
  }

  /**
   * Throttle that defers, never drops. Forced: the in-flight read, else a read now. Not forced: a read now when idle (nothing in flight,
   * last read started >= REFRESH_SPACING_MS ago); otherwise the ONE trailing read scheduled for the end of the window, which every later
   * request shares until it fires and which always runs (after any read still in flight). Each promise settles with its own read.
   */
  private refreshShared(force: boolean): Promise<void> {
    if (force) return this.refreshing ?? this.startRefresh();
    const at = this.now();
    const last = this.lastRefreshAt;
    const inWindow = last !== null && at >= last && at - last < REFRESH_SPACING_MS;
    if (this.refreshing === null && !inWindow) return this.startRefresh();
    if (this.trailing !== null) return this.trailing;
    const delay = last === null || at < last ? 0 : Math.max(0, last + REFRESH_SPACING_MS - at);
    const trailing = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        // Requests from now on schedule the next trailing read: this one may already have missed them.
        if (this.trailing === trailing) this.trailing = null;
        const run = (): void => { this.startRefresh().then(resolve, reject); };
        const inFlight = this.refreshing;
        if (inFlight === null) run(); else inFlight.then(run, run);
      }, delay);
    });
    trailing.catch(() => undefined);
    this.trailing = trailing;
    return trailing;
  }

  private startRefresh(): Promise<void> {
    const run = (async () => {
      await this.load();
      await this.refreshNow();
    })();
    this.refreshing = run;
    this.lastRefreshAt = this.now();
    const settle = (): void => { if (this.refreshing === run) this.refreshing = null; };
    run.then(settle, settle);
    return run;
  }

  private async refreshNow(): Promise<void> {
    const raw = this.deps.replica.raw();
    if (raw === null) return;
    const accountId = raw.checkpoint.accountId;
    const seq = this.nextExchange();
    const response = await this.request("GET", `/api/account/ledger?accountId=${encodeURIComponent(accountId)}`);
    if (response.status === 404) {
      // A server without the account is not "behind": a POST would be an account creation, which only the owner starts.
      this.serverGone(seq);
      throw new Error("account_not_found");
    }
    if (response.status === 429 || response.status >= 500) throw new StoreError("server_unavailable", response.retryAfterMs);
    // Offered, recorded, and when the server is behind the local chain, re-offered (see serverChain).
    await this.serverChain(this.ledgerOf(response, "account_not_found"), accountId, seq);
  }

  /** The signing credential: this session's, the only authority, or the one picked in an identification gesture. */
  private async signer(raw: Base): Promise<string> {
    return this.signerAmong(raw, raw.checkpoint.authorities.map(item => item.credentialId));
  }
  /** signer() restricted to `ids` (a resolution: the authorities at the fork point). */
  private async signerAmong(raw: Base, ids: string[]): Promise<string> {
    if (this.credentialId !== null && ids.indexOf(this.credentialId) !== -1) return this.credentialId;
    if (ids.length === 1) return ids[0];
    if (ids.length === 0) throw new Error("passkey_not_authority");
    return this.identifySigner(raw, ids);
  }

  private async identifySigner(raw: Base, allowed?: string[]): Promise<string> {
    const ids = allowed ?? raw.checkpoint.authorities.map(item => item.credentialId);
    const picked = await this.deps.passkey.identifyPasskey({ rpId: raw.ledger.genesis.payload.rpId, allowCredentialIds: ids });
    if (picked.handle !== raw.ledger.genesis.payload.handle) throw new Error("ledger_other_account");
    if (ids.indexOf(picked.credentialId) === -1) throw new Error("passkey_not_authority");
    this.credentialId = picked.credentialId;
    return picked.credentialId;
  }

  private async proveSession(accountId: string, device: Device): Promise<boolean> {
    const response = await this.request("POST", "/api/auth/nonce", { purpose: "session" });
    const value = isPlain(response.value) ? response.value : {};
    if (response.status !== 200 || typeof value.nonce !== "string") throw new Error("server_unavailable");
    const proof = await signAuthProof(device.key.privateKey, {
      accountId, kind: "device", keyId: device.identity.endpoint.id, nonce: value.nonce, purpose: "session", audience: this.origin,
    });
    return (await this.deps.signIn(JSON.stringify(proof))) === true;
  }

  /** This browser's endpoint (owned by `accountId`, kind browser) and device key; remembered for the device_revoked status. */
  private async loadDevice(accountId: string): Promise<Device> {
    const identity = await this.deps.endpoint(accountId);
    if (identity.endpoint.ownerId !== accountId || identity.endpoint.kind !== "browser") throw new Error("endpoint_invalid");
    const key = await this.deps.deviceKey();
    this.device = { accountId, endpoint: identity.endpoint, authPublicKey: key.publicKey };
    return { identity, key };
  }

  /** Trust view of a base: replica.trusted() (sticky applied) when the base is the replica's chain, else the base's own checkpoint. */
  private trustedFor(base: Base): LedgerCheckpoint {
    const trusted = this.deps.replica.trusted();
    const raw = this.deps.replica.raw();
    if (trusted !== null && raw !== null && raw.checkpoint.head === base.checkpoint.head) return trusted;
    return base.checkpoint;
  }

  private ledgerOf(response: HttpResult, missing: string): unknown {
    if (response.status === 404) throw new Error(missing);
    if (response.status !== 200 || !isPlain(response.value) || response.value.ledger === undefined) {
      throw new Error(response.status === 429 || response.status >= 500 ? "server_unavailable" : "ledger_invalid");
    }
    return response.value.ledger;
  }

  /** Attempts so far for a pairing request: the larger of this page's count and the persisted one (unreadable counts as exhausted). */
  private attempts(requestId: string): number {
    const local = this.memoryAttempts.get(requestId) ?? 0;
    const storage = this.deps.attemptStorage;
    if (storage === undefined) return local;
    try {
      const stored = storage.getItem(ATTEMPT_KEY + requestId);
      if (stored === null) return local;
      const count = Number(stored);
      return Number.isSafeInteger(count) && count >= 0 ? Math.max(local, count) : MAX_CODE_ATTEMPTS;
    } catch {
      return local;
    }
  }
  private setAttempts(requestId: string, count: number): void {
    this.memoryAttempts.set(requestId, count);
    try { this.deps.attemptStorage?.setItem(ATTEMPT_KEY + requestId, String(count)); } catch { /* the page count still applies */ }
  }
  private clearAttempts(requestId: string): void {
    this.memoryAttempts.delete(requestId);
    try { this.deps.attemptStorage?.removeItem(ATTEMPT_KEY + requestId); } catch { /* nothing persisted */ }
  }

  private async request(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<HttpResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        // Browser fetch is a global capability, not a method of this client.
        response = await this.fetcher.call(globalThis, `${this.origin}${path}`, {
          method, credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
          ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        });
      } catch {
        throw new Error("network_unavailable");
      }
      if (response.status === 204) return { status: 204, value: null };
      let retryAfter: string | null = null;
      try { retryAfter = response.headers.get("Retry-After"); } catch { retryAfter = null; }
      let text: string;
      try { text = await response.text(); } catch { throw new Error("network_unavailable"); }
      if (text.length > MAX_RESPONSE_CHARS) throw new Error("ledger_limit");
      let value: unknown = null;
      try { value = text ? JSON.parse(text) : null; } catch { value = null; }
      const retryAfterMs = retryAfterOf(retryAfter, this.now());
      return retryAfterMs === undefined ? { status: response.status, value } : { status: response.status, value, retryAfterMs };
    } finally {
      clearTimeout(timer);
    }
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const task = async (): Promise<T> => {
      this.exclusiveActive += 1;
      try {
        return await run();
      } finally {
        this.exclusiveActive -= 1;
      }
    };
    const result = this.lock.then(task, task);
    this.lock = result.then(() => undefined, () => undefined);
    return result.catch(error => { throw coded(error); });
  }

  private publish(): void {
    const trusted = this.deps.replica.trusted();
    const pending: LedgerClientPending = this.authority !== null ? (this.authority.consent === null ? "authority_created" : "authority_consented")
      : this.enrollment !== null ? "enrollment_ready" : this.creation !== null ? "passkey_created" : "none";
    let status: LedgerClientSnapshot["status"] = trusted === null ? "signed_out" : "ready";
    const device = this.device;
    if (trusted !== null && device !== null && device.accountId === trusted.accountId) {
      const state = membership(trusted, device.endpoint, device.authPublicKey);
      if (state === "revoked" || state === "conflict") status = "device_revoked";
    }
    const raw = this.deps.replica.raw();
    const sticky = this.deps.replica.sticky();
    const localOnly = raw === null || sticky === null ? { deviceIds: [], bridgeIds: [] } : {
      deviceIds: sticky.deviceIds.filter(id => raw.checkpoint.devices.some(item => item.endpoint.id === id)),
      bridgeIds: sticky.bridgeIds.filter(id => raw.checkpoint.bridges.some(item => item.bridgeId === id)),
    };
    const ids = raw === null ? null : raw.checkpoint.authorities.map(item => item.credentialId);
    const signer = ids === null ? this.credentialId
      : this.credentialId !== null && ids.indexOf(this.credentialId) !== -1 ? this.credentialId : ids.length === 1 ? ids[0] : null;
    const serverState = this.behind() ? "behind" : this.converged() ? "current" : "unknown";
    const pendingWrite = this.visiblePending();
    const view = this.divergenceView;
    const shown = this.currentDivergence();
    // Only a view computed for this local head and the divergent chain shown now (afterReplicaChange keeps it current).
    const divergence = view !== null && raw !== null && shown !== null && view.localHead === raw.checkpoint.head && view.source === shown.source
      && view.entry.ledger === shown.ledger ? view.value : null;
    this.update({
      status, checkpoint: trusted, discarded: this.deps.replica.discarded(), localOnly, signer, pending,
      pendingWrite, lastConflict: this.lastConflict, divergence,
      serverState, unsaved: this.unsavedIds(pendingWrite), retryAt: this.retryTimerAt,
      retryNotBefore: this.retryAfterUntil > 0 ? this.retryAfterUntil : null, canReoffer: this.canReoffer(status),
    });
  }

  private update(value: LedgerClientSnapshot): void {
    this.value = value;
    for (const listener of Array.from(this.listeners)) listener();
  }
}
