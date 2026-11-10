import { accountIdOf, chooseLedger, LedgerError, ledgerHead, ledgerLastIssuedAt, nextTransition, parseLedger, verifyLedger } from "@security/ledger/ledger";
import { bridgeFromPairRequest, pairComparisonCode, parsePairLink, sealPairApproval } from "@security/ledger/pairing";
import { signAuthProof } from "@security/ledger/proof";
import { LEDGER_LIMITS } from "@security/ledger/protocol";
import type { Ledger, LedgerCheckpoint, LedgerGenesis, LedgerOperation, LedgerTransition, PasskeySignature, Signed } from "@security/ledger/protocol";
import type { EndpointIdentity, EndpointPublic } from "@security/protocol";
import type * as PasskeyModule from "./passkey";
import type { LedgerReplica, ReplicaOfferOptions } from "./ledger-replica";

/*
 * Browser client of the passkey ledger (CONTRACT C4; WAVE3 U2; U2 review amendment). Every ledger write is a passkey-signed transition
 * built on the replica's RAW checkpoint; every trust decision (membership, bridge access) uses replica.trusted(), which applies sticky
 * revocations. The replica binds only to a chain this client verified itself: its own signed chain, or a chain fetched by the passkey's
 * handle whose genesis carries that handle and whose verified authorities include the identifying credential. Each WebAuthn ceremony
 * has its own public step so the UI can run it from its own user gesture (Safari); the combined methods only chain those steps.
 * Errors are Error(code) with a stable snake_case message.
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
}
export type LedgerClientPending = "none" | "passkey_created" | "enrollment_ready" | "authority_created" | "authority_consented";
export interface LedgerClientSnapshot {
  /** device_revoked: the account is known but this browser's keys are revoked (or replaced); see rotateDeviceIdentity(). */
  status: "signed_out" | "ready" | "device_revoked" | "error";
  /** trusted(): sticky revocations applied. */
  checkpoint: LedgerCheckpoint | null;
  /** Records to sign again (dropped by an adopted fork, or own appends that never made it); persisted until dismissed or effective. */
  discarded: Signed<LedgerTransition>[];
  /** Ids revoked only on this browser: in the sticky set but still present in the RAW chain. revokeDevice/revokeBridge accept them. */
  localOnly: { deviceIds: string[]; bridgeIds: string[] };
  /** The credential this device is known to hold (the only authority, or learned from a prompt or a signature), else null. */
  signer: string | null;
  /** Which multi-gesture flow is half done. */
  pending: LedgerClientPending;
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
interface HttpResult { status: number; value: unknown }

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

  constructor(private readonly deps: LedgerClientDeps) {
    if (canonicalOrigin(deps.origin) !== deps.origin || deps.origin === "null") throw new Error("invalid_origin");
    if (typeof deps.rpId !== "string" || !deps.rpId) throw new Error("invalid_rp_id");
    this.origin = deps.origin;
    this.rpId = deps.rpId;
    this.now = deps.now ?? Date.now;
    this.fetcher = deps.fetchImpl ?? fetch;
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
        this.publish();
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
      const response = await this.request("GET", `/api/account/ledger?handle=${encodeURIComponent(picked.handle)}`);
      let base: Base;
      if (response.status === 404 && bound !== null) {
        base = bound;
      } else {
        const candidate = this.ledgerOf(response, "account_not_found");
        if (bound !== null) {
          const parsed = parseLedger(candidate);
          if (await accountIdOf(parsed.genesis.payload) !== bound.checkpoint.accountId) throw new Error("ledger_other_account");
          await this.offerToReplica(candidate, { expectAccountId: bound.checkpoint.accountId });
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
        await this.refreshShared(true);
        base = this.deps.replica.raw() ?? enrollment;
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
        } else {
          await this.submit(base.ledger, signed, accountId);
        }
      } else if (bound === null) {
        await this.offerToReplica(base.ledger, { bind: true, expectAccountId: accountId });
      }
      await this.enrolled(enrollment, accountId, device);
    });
  }

  /** The creating POST: server rejection reasons surface as their own client codes (see CREATION_REASONS). */
  private async postCreation(enrollment: PendingEnrollment, signed: Signed<LedgerTransition>, accountId: string): Promise<void> {
    await this.submit(enrollment.ledger, signed, accountId, true);
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
      const fresh = await this.loadDevice(accountId);
      const trusted = this.deps.replica.trusted();
      if (trusted !== null && membership(trusted, fresh.identity.endpoint, fresh.key.publicKey) !== "absent") throw new Error("device_rotation_failed");
      this.publish();
    });
  }

  // ---- Ledger writes (one gesture each once the signing credential is known). ----

  /** Refreshes, then signs `operation` on the replica's head with this session's credential and stores it on the server. */
  append(operation: LedgerOperation): Promise<void> {
    return this.exclusive(() => this.appendNow(() => operation));
  }
  /**
   * Validated against the RAW chain (not trusted()), before any prompt: an id revoked only on this browser (snapshot.localOnly) is
   * still on the chain and can be revoked there again. Error('device_not_found') / Error('bridge_not_found') otherwise.
   */
  revokeDevice(endpointId: string): Promise<void> {
    return this.exclusive(() => this.appendNow(() => ({ type: "revoke_device", endpointId }), {
      check: raw => { if (!raw.checkpoint.devices.some(item => item.endpoint.id === endpointId)) throw new Error("device_not_found"); },
    }));
  }
  revokeBridge(bridgeId: string): Promise<void> {
    return this.exclusive(() => this.appendNow(() => ({ type: "revoke_bridge", bridgeId }), {
      check: raw => { if (!raw.checkpoint.bridges.some(item => item.bridgeId === bridgeId)) throw new Error("bridge_not_found"); },
    }));
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

  // ---- Replication. ----

  /**
   * GET the bound account's ledger and offer it to the replica. No-op while signed out. Reads start at least 2 s apart: when idle the
   * read starts now; otherwise the call joins the one trailing read at the end of the window (deferred, never dropped) and resolves
   * with it. `force` skips the spacing but joins a read already in flight.
   */
  async refresh(options: { force?: boolean } = {}): Promise<void> {
    try {
      await this.refreshShared(options.force === true);
    } catch (error) {
      throw coded(error);
    }
  }

  /**
   * A head announced by the relay. Refreshes (paced like refresh(): immediately when idle, else one trailing read at the end of the
   * window) only when it is ahead of the local RAW chain: a higher revision, or the same revision with another head (a fork). A lower
   * revision, or the same revision and head, is ignored. Resolves once the read it caused is done. Never throws: it is only a hint.
   */
  async noteHead(head: string, revision: number): Promise<void> {
    try {
      await this.load();
      const raw = this.deps.replica.raw();
      if (raw === null || typeof head !== "string" || !Number.isSafeInteger(revision)) return;
      const local = raw.checkpoint;
      if (revision > local.revision || (revision === local.revision && head !== local.head)) await this.refreshShared(false);
    } catch {
      // The next explicit refresh reports the failure.
    }
  }

  /**
   * A ledger pushed on `account:ledger#<accountId>`: a bare ledger, `{type:'ledger', ledger}`, or `{type:'ledger_head', head, revision}`
   * (see noteHead). Ignored while unbound (a push never selects the account); foreign or invalid chains are ignored.
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
      await this.offerToReplica(isPlain(candidate) && candidate.type === "ledger" ? candidate.ledger : candidate,
        { bind: false, expectAccountId: raw.checkpoint.accountId });
    } catch (error) {
      throw coded(error);
    }
  }

  /** Throws Error('account_bridge_revoked') unless `bridgeId` is a trusted (sticky-filtered) bridge with exactly that endpoint id. */
  assertBridgeAccess(bridgeId: string, endpointId: string): void {
    const trusted = this.deps.replica.trusted();
    if (trusted === null || !trusted.bridges.some(item => item.bridgeId === bridgeId && item.endpoint.id === endpointId)) {
      throw new Error("account_bridge_revoked");
    }
  }

  /** Clears the (persisted) discarded-records notice after the UI showed it. */
  async dismissDiscarded(): Promise<void> {
    try {
      await this.deps.replica.dismissDiscarded();
    } finally {
      this.publish();
    }
  }

  /**
   * Forgets this browser's account binding, chain and discarded records, and every half-done flow (a pending creation and its secret
   * included). The account's sticky revocations are kept.
   */
  forget(): Promise<void> {
    return this.exclusive(async () => {
      this.credentialId = null;
      this.creation = null;
      this.enrollment = null;
      this.authority = null;
      this.device = null;
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
      return choice.decision === "adopt" ? { ledger: candidate, checkpoint: choice.checkpoint } : base;
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
    // Never sign on a stale head: that would fork the account.
    if (options.refreshed !== true) await this.refreshShared(true);
    const raw = this.deps.replica.raw();
    if (raw === null) throw new Error("signed_out");
    if (options.check !== undefined) options.check(raw);
    const credentialId = await this.signer(raw);
    let signed: Signed<LedgerTransition>;
    try {
      signed = await this.signTransition(raw, credentialId, build);
    } catch (error) {
      if (code(error) === "passkey_wrong_credential") this.credentialId = null;
      throw error;
    }
    await this.submit(raw.ledger, signed, raw.checkpoint.accountId);
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
   * Stores base + record. A bound replica adopts this own chain BEFORE the POST, so a signed revocation is kept (and sticky) locally
   * whatever the server answers. An unbound replica binds only to this own chain, after the server accepted it. The server's answer
   * is then offered like any other candidate (never binding). Throws ledger_append_lost when the record is not in the chain that won
   * (it is added to the persisted discarded list), ledger_not_stored when the server's chain lacks it (it stays in the local chain,
   * and is re-sent with the next write).
   */
  private async submit(
    base: Ledger, record: Signed<LedgerTransition>, accountId: string, creating = false,
  ): Promise<void> {
    const chain: Ledger = { genesis: base.genesis, transitions: base.transitions.concat([record]) };
    const head = await ledgerHead(record.payload);
    const wasBound = this.deps.replica.raw() !== null;
    if (wasBound) {
      const own = await this.offerToReplica(chain, { expectAccountId: accountId });
      if (own === "reject") throw new Error("ledger_rejected");
      // 'keep' of a chain without the record: a longer chain arrived (relay) while the passkey prompt was open.
      if (own === "keep" && !await holds(this.deps.replica.raw()?.ledger, record.payload.revision, head)) await this.lost(record);
    }
    const response = await this.request("POST", "/api/account/ledger", { ledger: chain });
    const value = isPlain(response.value) ? response.value : {};
    if (creating && response.status !== 200 && response.status !== 201 && typeof value.error === "string" && CREATION_REASONS.indexOf(value.error) !== -1) {
      throw new Error(value.error);
    }
    if (response.status === 403) throw new Error(value.error === "registration_closed" ? "registration_closed" : "ledger_rejected");
    if (response.status === 409) {
      if (wasBound && value.ledger !== null && value.ledger !== undefined) await this.offerToReplica(value.ledger, { expectAccountId: accountId });
      throw new Error("ledger_rejected");
    }
    if (response.status === 413) throw new Error("ledger_limit");
    // A per-account write limit: the signed record is already in the local chain (kept like after any transient failure) and is re-sent later.
    if (response.status === 429 && value.error === "rate_limited") throw new Error("rate_limited");
    if (response.status !== 200 && response.status !== 201) throw new Error(response.status === 429 || response.status >= 500 ? "server_unavailable" : "ledger_rejected");
    if (!wasBound && await this.offerToReplica(chain, { bind: true, expectAccountId: accountId }) !== "adopt") throw new Error("ledger_rejected");
    await this.offerToReplica(value.ledger, { expectAccountId: accountId });
    if (!await holds(this.deps.replica.raw()?.ledger, record.payload.revision, head)) await this.lost(record);
    if (!await holds(value.ledger, record.payload.revision, head)) throw new Error("ledger_not_stored");
  }

  /** An own record that is not in the winning chain: keep it (persisted) for re-signing, then report it. */
  private async lost(record: Signed<LedgerTransition>): Promise<never> {
    try {
      await this.deps.replica.noteDiscarded([record]);
    } finally {
      this.publish();
    }
    throw new Error("ledger_append_lost");
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
    const response = await this.request("GET", `/api/account/ledger?accountId=${encodeURIComponent(accountId)}`);
    await this.offerToReplica(this.ledgerOf(response, "account_not_found"), { expectAccountId: accountId });
  }

  private async offerToReplica(candidate: unknown, options: ReplicaOfferOptions): Promise<"adopt" | "keep" | "reject"> {
    const result = await this.deps.replica.offer(candidate, options);
    this.publish();
    return result.decision;
  }

  /** The signing credential: this session's, the only authority, or the one picked in an identification gesture. */
  private async signer(raw: Base): Promise<string> {
    const ids = raw.checkpoint.authorities.map(item => item.credentialId);
    if (this.credentialId !== null && ids.indexOf(this.credentialId) !== -1) return this.credentialId;
    if (ids.length === 1) return ids[0];
    return this.identifySigner(raw);
  }

  private async identifySigner(raw: Base): Promise<string> {
    const ids = raw.checkpoint.authorities.map(item => item.credentialId);
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
      let text: string;
      try { text = await response.text(); } catch { throw new Error("network_unavailable"); }
      if (text.length > MAX_RESPONSE_CHARS) throw new Error("ledger_limit");
      let value: unknown = null;
      try { value = text ? JSON.parse(text) : null; } catch { value = null; }
      return { status: response.status, value };
    } finally {
      clearTimeout(timer);
    }
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.lock.then(run, run);
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
    this.update({ status, checkpoint: trusted, discarded: this.deps.replica.discarded(), localOnly, signer, pending });
  }

  private update(value: LedgerClientSnapshot): void {
    this.value = value;
    for (const listener of Array.from(this.listeners)) listener();
  }
}
