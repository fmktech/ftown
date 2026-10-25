import { AccountTrustError, ACCOUNT_TRUST_LIMITS, createAccountEnrollment, createAccountGenesis, encodeAccountEnrollmentLink,
  openAccountApproval, parseAccountEnrollmentLink, parseAccountEnrollmentRequest, parseAccountHistory, sealAccountApproval,
  signAccountTransition, verifyAccountHistory } from "@security/account-crypto";
import type { AccountEnrollmentBundle, AccountEnrollmentLink, AccountEnrollmentRequest, AccountEnrollmentStatus, AccountErrorCode,
  AccountHistory, AccountOperation, AccountSigningIdentity, StoredAccountTrust } from "@security/account-protocol";
import type { ApprovedBridge, EndpointIdentity, SecurityCommand, SecurityCommandResults } from "@security/protocol";
import { loadAccountSigningIdentity, loadBrowserIdentity, persistAccountTrust, readAccountEnrollment, readAccountTrust,
  readPinnedBridges, storeAccountEnrollment } from "./browser-identity";

export type AccountSecuritySnapshot = {
  status: "checking" | "unapproved" | "ready" | "error";
  identity: EndpointIdentity | null; signing: AccountSigningIdentity | null; trust: StoredAccountTrust | null;
  legacyBridges: ApprovedBridge[]; historyExists: boolean; code: AccountErrorCode | null; offline: boolean;
  bootstrapRecoverable?: boolean;
};
export type ExecuteSecurity = <C extends SecurityCommand>(command: C) => Promise<SecurityCommandResults[C["type"]]>;
export const accountStorage = { loadBrowserIdentity, loadAccountSigningIdentity, readAccountTrust, persistAccountTrust, readPinnedBridges, readAccountEnrollment, storeAccountEnrollment };
const codes: readonly string[] = ["invalid_account_trust", "account_trust_conflict", "account_trust_rollback", "account_approval_required", "account_device_revoked",
  "account_bridge_revoked", "account_offline_expired", "account_last_admin", "account_capacity_exceeded", "account_enrollment_expired", "account_enrollment_invalid", "account_storage_unavailable"];
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function failure(error: unknown): AccountTrustError {
  return new AccountTrustError(object(error) && typeof error.code === "string" && codes.includes(error.code) ? error.code as AccountErrorCode : "account_storage_unavailable");
}
class AccountReadUnavailable extends Error {}
const head = (trust: StoredAccountTrust) => ({ rootId: trust.checkpoint.rootId, revision: trust.checkpoint.revision, head: trust.checkpoint.head });

/** Owner-scoped orchestration. Only verified history enters storage or transport pins. */
export class AccountSecurityClient {
  private value: AccountSecuritySnapshot = { status: "checking", identity: null, signing: null, trust: null, legacyBridges: [], historyExists: false, code: null, offline: false };
  private listeners = new Set<() => void>();
  private refreshing: Promise<AccountSecuritySnapshot> | null = null;
  private generation = 0;
  private abort = new AbortController();
  private closed = false;
  private remoteHistory: AccountHistory | null = null;
  private remoteReadAt = 0;
  private admissionTrust: StoredAccountTrust | null = null;
  private verifiedRead: { wall: number; monotonic: number } | null = null;
  private observedWall = 0;
  private observedMonotonic = 0;
  private blocked: AccountErrorCode | null = null;
  /** Only roster-derived authority is gated; independent legacy/local pins retain their own policy. */
  assertBridgeAccess = (bridgeId: string): void => {
    const checkpoint = this.admissionTrust?.checkpoint;
    if (!checkpoint || !checkpoint.bridges.some(bridge => bridge.bridgeId === bridgeId) && !checkpoint.revokedBridgeIds.includes(bridgeId)) return;
    try { this.checkMember(this.admissionTrust!); }
    catch (error) { this.block(error); throw error; }
    if (checkpoint.revokedBridgeIds.includes(bridgeId)) throw new AccountTrustError("account_bridge_revoked");
    this.assertFresh();
  };
  private assertFresh(): void {
    this.active();
    if (this.blocked) throw new AccountTrustError(this.blocked);
    if (!this.verifiedRead) throw new AccountTrustError("account_approval_required");
    const wall = Date.now(); const monotonic = performance.now();
    if (wall < this.observedWall || monotonic < this.observedMonotonic
      || wall - this.verifiedRead.wall > ACCOUNT_TRUST_LIMITS.offlineGraceMs
      || monotonic - this.verifiedRead.monotonic > ACCOUNT_TRUST_LIMITS.offlineGraceMs) {
      this.blocked = "account_offline_expired";
      this.update({ ...this.value, status: "error", trust: null, code: this.blocked, offline: true });
      throw new AccountTrustError(this.blocked);
    }
    this.observedWall = wall; this.observedMonotonic = monotonic;
  }
  private verified(trust: StoredAccountTrust): void {
    this.checkMember(trust);
    this.admissionTrust = trust;
    this.verifiedRead = { wall: trust.lastServerReadAt, monotonic: performance.now() };
    this.observedWall = Math.max(this.observedWall, trust.lastObservedAt, Date.now());
    this.observedMonotonic = this.verifiedRead.monotonic;
    this.blocked = null;
  }
  private block(error: unknown): void {
    const code = failure(error).code;
    this.blocked = code;
    this.update({ ...this.value, status: "error", trust: null, code, offline: false });
  }
  private async verifyHistory(...args: Parameters<typeof verifyAccountHistory>): ReturnType<typeof verifyAccountHistory> {
    try {
      const checkpoint = await verifyAccountHistory(...args);
      if (checkpoint.ownerId !== this.ownerId) throw new AccountTrustError("invalid_account_trust");
      return checkpoint;
    } catch (error) { this.block(error); throw error; }
  }
  private async persist(...args: Parameters<typeof persistAccountTrust>): ReturnType<typeof persistAccountTrust> {
    try { return await this.storage.persistAccountTrust(...args); }
    catch (error) { this.block(error); throw error; }
  }
  constructor(readonly ownerId: string, private fetcher: typeof fetch = fetch, private storage = accountStorage) {}
  snapshot = (): AccountSecuritySnapshot => this.value;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(value: AccountSecuritySnapshot): void { if (!this.closed) { this.value = value; for (const listener of this.listeners) listener(); } }
  private active(generation = this.generation): void { if (this.closed || generation !== this.generation) throw new AccountTrustError("account_approval_required"); }
  private async keys(): Promise<void> {
    if (this.value.identity && this.value.signing) return;
    const generation = this.generation;
    const [identity, signing, legacyBridges] = await Promise.all([this.storage.loadBrowserIdentity(this.ownerId), this.storage.loadAccountSigningIdentity(this.ownerId), this.storage.readPinnedBridges(this.ownerId)]);
    this.active(generation); this.value = { ...this.value, identity, signing, legacyBridges };
  }
  private async json(path: string, body?: unknown): Promise<unknown> {
    this.active();
    let response: Response;
    try {
      // Browser fetch is a global capability, not a method of this client.
      response = await this.fetcher.call(globalThis, path, { method: body === undefined ? "GET" : "POST", credentials: "include", cache: "no-store", redirect: "error",
        signal: this.abort.signal, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    } catch { this.active(); throw new AccountReadUnavailable(); }
    this.active();
    if (response.status >= 500) throw new AccountReadUnavailable();
    const text = await response.text(); this.active();
    if (text.length > ACCOUNT_TRUST_LIMITS.maxHistoryBytes + 65536) throw new AccountTrustError("account_capacity_exceeded");
    let value: unknown; try { value = JSON.parse(text); } catch { throw new AccountTrustError("invalid_account_trust"); }
    if (!response.ok) {
      const error = object(value) && object(value.error) ? value.error : {};
      throw new AccountTrustError(typeof error.code === "string" && codes.includes(error.code) ? error.code as AccountErrorCode
        : response.status === 409 ? "account_trust_conflict" : response.status === 410 ? "account_enrollment_expired" : "account_approval_required");
    }
    return value;
  }
  private async history(): Promise<AccountHistory | null> {
    try {
      const value = await this.json("/api/security/account");
      if (!object(value) || !("history" in value)) throw new AccountTrustError("invalid_account_trust");
      return value.history === null ? null : parseAccountHistory(value.history);
    } catch (error) { if (!(error instanceof AccountReadUnavailable)) this.block(error); throw error; }
  }
  private checkMember(trust: StoredAccountTrust): void {
    const device = trust.checkpoint.devices.find(item => item.endpoint.id === this.value.identity?.endpoint.id);
    if (!device || device.endpoint.publicKey !== this.value.identity?.endpoint.publicKey || device.signingPublicKey !== this.value.signing?.publicKey) throw new AccountTrustError("account_device_revoked");
  }
  refresh = (): Promise<AccountSecuritySnapshot> => {
    if (this.refreshing) return this.refreshing;
    const work = this.read(); this.refreshing = work;
    void work.finally(() => { if (this.refreshing === work) this.refreshing = null; }).catch(() => {});
    return work;
  };
  private async read(): Promise<AccountSecuritySnapshot> {
    const generation = this.generation;
    let previous: StoredAccountTrust | null = null;
    try {
      await this.keys(); previous = await this.storage.readAccountTrust(this.ownerId); this.active(generation);
      if (previous) this.admissionTrust = previous;
      const now = Date.now();
      if (now < this.observedWall || previous && now < previous.lastObservedAt) throw new AccountTrustError("account_offline_expired");
      const history = await this.history(); this.active(generation);
      this.remoteHistory = history; this.remoteReadAt = Date.now();
      if (!history) {
        if (previous) throw new AccountTrustError("account_trust_rollback");
        this.update({ ...this.value, status: "unapproved", trust: null, historyExists: false, code: null, offline: false });
      } else {
        const checkpoint = await this.verifyHistory(history, previous?.checkpoint ?? null); this.active(generation);
        if (checkpoint.ownerId !== this.ownerId) throw new AccountTrustError("invalid_account_trust");
        if (!previous) this.update({ ...this.value, status: "unapproved", trust: null, historyExists: true, code: null, offline: false,
          bootstrapRecoverable: history.genesis.payload.device.endpoint.id === this.value.identity!.endpoint.id
            && history.genesis.payload.device.endpoint.publicKey === this.value.identity!.endpoint.publicKey
            && history.genesis.payload.device.signingPublicKey === this.value.signing!.publicKey });
        else {
          const trust = await this.persist(this.ownerId, { history, checkpoint }, { serverReadAt: Date.now() }); this.active(generation);
          this.verified(trust); this.update({ ...this.value, status: "ready", trust, historyExists: true, code: null, offline: false });
        }
      }
    } catch (error) {
      if (this.closed || generation !== this.generation) return this.value;
      if (error instanceof AccountReadUnavailable && previous && this.verifiedRead && !this.blocked && Date.now() >= previous.lastObservedAt) {
        try {
          this.assertFresh();
          const trust = await this.persist(this.ownerId, previous); this.active(generation); this.assertFresh(); this.checkMember(trust);
          this.update({ ...this.value, status: "ready", trust, historyExists: true, code: "account_storage_unavailable", offline: true });
        } catch (storageError) { this.blocked = failure(storageError).code; this.update({ ...this.value, status: "error", trust: null, code: this.blocked, offline: true }); }
      } else {
        if (!(error instanceof AccountReadUnavailable)) this.blocked = failure(error).code;
        const code = this.blocked ?? failure(error).code;
        this.update({ ...this.value, status: "error", trust: null, code, offline: error instanceof AccountReadUnavailable });
      }
    }
    return this.value;
  }
  /** Only explicit bridge bootstrap/migration calls this, never an ordinary login. */
  private async establish(): Promise<StoredAccountTrust> {
    await this.refresh(); this.active();
    if (this.value.status === "ready" && this.value.trust) return this.value.trust;
    // An earlier explicit bootstrap may have committed before its response was
    // lost. Recover only the genesis signed by these exact locally held keys,
    // and only from this explicit bridge/migration action, never ordinary login.
    if (this.value.status === "unapproved" && this.value.bootstrapRecoverable && this.remoteHistory) {
      const checkpoint = await this.verifyHistory(this.remoteHistory, null);
      const trust = await this.persist(this.ownerId, { history: this.remoteHistory, checkpoint }, { bootstrap: true, serverReadAt: this.remoteReadAt }); this.active();
      this.verified(trust); this.update({ ...this.value, status: "ready", trust, code: null, offline: false }); return trust;
    }
    if (this.value.trust || this.value.historyExists || this.value.status === "error") throw new AccountTrustError("account_approval_required");
    const identity = this.value.identity!; const signing = this.value.signing!;
    const genesis = await createAccountGenesis(this.ownerId, identity.endpoint, signing, "This device");
    const initial: AccountHistory = { genesis, transitions: [] };
    const checkpoint = await this.verifyHistory(initial, null);
    await this.json("/api/security/account", { expectedHead: null, record: genesis });
    const history = await this.history(); if (!history) throw new AccountTrustError("account_trust_rollback");
    const latest = await this.verifyHistory(history, checkpoint); this.active();
    const trust = await this.persist(this.ownerId, { history, checkpoint: latest }, { bootstrap: true, serverReadAt: Date.now() }); this.active();
    this.verified(trust); this.update({ ...this.value, status: "ready", trust, historyExists: true, code: null, offline: false });
    return trust;
  }
  private async append(operation: AccountOperation): Promise<StoredAccountTrust> {
    await this.refresh(); this.active();
    const current = this.value.trust;
    if (this.value.status !== "ready" || !current || this.value.offline) throw new AccountTrustError("account_approval_required");
    const last = current.history.transitions.at(-1)?.payload.issuedAt ?? current.history.genesis.payload.createdAt;
    const record = await signAccountTransition(current.checkpoint, this.value.identity!.endpoint.id, this.value.signing!, operation, Math.max(Date.now(), Date.parse(last)));
    const intended: AccountHistory = { ...current.history, transitions: [...current.history.transitions, record] };
    const expected = await this.verifyHistory(intended, current.checkpoint);
    await this.json("/api/security/account", { expectedHead: head(current), record });
    const history = await this.history(); if (!history) throw new AccountTrustError("account_trust_rollback");
    const checkpoint = await this.verifyHistory(history, expected); this.active();
    const trust = await this.persist(this.ownerId, { history, checkpoint }, { serverReadAt: Date.now() }); this.active();
    const own = trust.checkpoint.devices.some(device => device.endpoint.id === this.value.identity!.endpoint.id);
    this.admissionTrust = trust;
    if (own) this.verified(trust); else this.blocked = "account_device_revoked";
    this.update({ ...this.value, status: own ? "ready" : "error", trust: own ? trust : null, historyExists: true, code: own ? null : "account_device_revoked", offline: false });
    return trust;
  }
  async approve(linkValue: AccountEnrollmentLink, initialBridge = false): Promise<AccountEnrollmentBundle> {
    const link = await parseAccountEnrollmentLink(linkValue);
    if (link.request.kind === "browser" && link.request.candidate.ownerId !== this.ownerId) throw new AccountTrustError("account_enrollment_invalid");
    await this.refresh(); this.active();
    let trust = initialBridge && link.request.kind === "bridge" ? await this.establish() : this.value.trust;
    if (!trust || this.value.status !== "ready") throw new AccountTrustError("account_approval_required");
    const request = link.request;
    const existing = request.kind === "browser" ? trust.checkpoint.devices.find(item => item.endpoint.id === request.candidate.id)
      : trust.checkpoint.bridges.find(item => item.bridgeId === request.bridgeId);
    if (!existing) {
      const approvedAt = new Date().toISOString();
      trust = await this.append(request.kind === "browser" ? { type: "add_device", device: { endpoint: request.candidate, signingPublicKey: request.signingPublicKey, label: request.label, approvedAt } }
        : { type: "add_bridge", bridge: { bridgeId: request.bridgeId, endpoint: { ...request.candidate, ownerId: this.ownerId }, label: request.label, approvedAt } });
    }
    return sealAccountApproval(this.value.identity!, link, trust.history);
  }
  async requestDevice(label: string): Promise<AccountEnrollmentLink> {
    await this.keys(); this.active();
    let link = await this.storage.readAccountEnrollment(this.ownerId);
    if (link) {
      try {
        link = await parseAccountEnrollmentLink(link);
        if (link.request.kind !== "browser" || link.request.candidate.id !== this.value.identity!.endpoint.id || link.request.signingPublicKey !== this.value.signing!.publicKey) link = null;
      } catch { link = null; }
    }
    if (!link) {
      link = await createAccountEnrollment(this.value.identity!, label.trim() || "Browser", this.value.signing!, null);
      await this.storage.storeAccountEnrollment(this.ownerId, link);
    }
    await this.json("/api/security/account/enrollments", link.request); this.active();
    return link;
  }
  async approveDevice(link: AccountEnrollmentLink): Promise<void> {
    const parsed = await parseAccountEnrollmentLink(link);
    if (parsed.request.kind !== "browser") throw new AccountTrustError("account_enrollment_invalid");
    const value = await this.json(`/api/security/account/enrollments/${parsed.request.requestId}`);
    if (!object(value) || JSON.stringify(await parseAccountEnrollmentRequest(value.request)) !== JSON.stringify(parsed.request)) throw new AccountTrustError("account_enrollment_invalid");
    const bundle = await this.approve(parsed);
    await this.json(`/api/security/account/enrollments/${parsed.request.requestId}`, { requestId: parsed.request.requestId, bundle });
  }
  async finishDevice(link: AccountEnrollmentLink): Promise<boolean> {
    await this.keys(); this.active();
    const parsed = await parseAccountEnrollmentLink(link);
    const value = await this.json(`/api/security/account/enrollments/${parsed.request.requestId}`) as AccountEnrollmentStatus;
    if (!object(value) || JSON.stringify(await parseAccountEnrollmentRequest(value.request)) !== JSON.stringify(parsed.request)) throw new AccountTrustError("account_enrollment_invalid");
    if (value.status === "pending" && value.bundle === null) return false;
    if (value.status !== "approved" || !value.bundle) throw new AccountTrustError("account_enrollment_invalid");
    const history = await this.history(); if (!history) throw new AccountTrustError("account_trust_rollback");
    const verified = await openAccountApproval(this.value.identity!, parsed, value.bundle, history); this.active();
    const trust = await this.persist(this.ownerId, verified, { bootstrap: true, serverReadAt: Date.now() }); this.active();
    this.verified(trust); await this.storage.storeAccountEnrollment(this.ownerId, null); this.active();
    this.update({ ...this.value, status: "ready", trust, historyExists: true, code: null, offline: false }); return true;
  }
  async revoke(endpointId: string): Promise<void> { await this.append({ type: "revoke_device", endpointId }); }
  async migrate(bridge: ApprovedBridge, execute: ExecuteSecurity): Promise<void> {
    await this.keys(); this.active();
    const pin = this.value.legacyBridges.find(item => item.bridgeId === bridge.bridgeId && item.endpoint.id === bridge.endpoint.id);
    if (!pin) throw new AccountTrustError("account_approval_required");
    const { devices } = await execute({ type: "security_devices", bridgeId: bridge.bridgeId });
    const actor = devices.find(item => item.endpoint.id === this.value.identity!.endpoint.id && item.permissions.includes("admin") && item.source !== "account");
    if (!actor) throw new AccountTrustError("account_approval_required");
    let trust = await this.establish();
    const existing = trust.checkpoint.bridges.find(item => item.bridgeId === bridge.bridgeId);
    if (!existing) trust = await this.append({ type: "add_bridge", bridge: { bridgeId: bridge.bridgeId, endpoint: bridge.endpoint, label: "Computer", approvedAt: new Date().toISOString() } });
    if (existing && existing.endpoint.id !== bridge.endpoint.id) throw new AccountTrustError("invalid_account_trust");
    const { head: adopted } = await execute({ type: "security_account_adopt", bridgeId: bridge.bridgeId, head: head(trust) });
    if (adopted.head !== trust.checkpoint.head || adopted.rootId !== trust.checkpoint.rootId || adopted.revision !== trust.checkpoint.revision) throw new AccountTrustError("account_trust_rollback");
  }
  /** Persists an observed clock only, never invents an authenticated server-read time. */
  flushObservation = async (): Promise<void> => {
    const known = this.admissionTrust; if (!known) return;
    const observed = Math.max(this.observedWall, Date.now());
    const current = await this.storage.readAccountTrust(this.ownerId); if (!current) return;
    const now = Math.max(observed, current.lastObservedAt);
    const checkpoint = await verifyAccountHistory(current.history, known.checkpoint, now);
    await this.storage.persistAccountTrust(this.ownerId, { history: current.history, checkpoint }, { now });
  };
  dispose(): void {
    this.closed = true; this.generation++; this.abort.abort(); this.listeners.clear();
    // Page teardown cannot guarantee an asynchronous write; startup still always
    // requires an authenticated read. Mounted callers can await this same flush.
    void this.flushObservation().catch(() => {});
  }
}

export async function readAccountSession(): Promise<{ id: string; email: string } | null> {
  const response = await fetch("/api/auth/session", { credentials: "include", cache: "no-store" });
  const value: unknown = response.ok ? await response.json().catch(() => null) : null;
  return object(value) && object(value.user) && typeof value.user.id === "string" && value.user.id.trim() && typeof value.user.email === "string" && value.user.email.trim()
    ? { id: value.user.id, email: value.user.email } : null;
}
const CONTINUATION = "ftown:account-link:";
export function safeAccountReturnTo(value: string | null): string | null {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//") || value.includes("#") || value.includes("\\")) return null;
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin) return null;
  if (url.pathname === "/devices/approve" && !url.search) return url.pathname;
  if (url.pathname === "/pair" && [...url.searchParams.keys()].every(key => key === "code") && url.searchParams.getAll("code").length <= 1
    && (!url.searchParams.has("code") || /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(url.searchParams.get("code")!))) return url.pathname + url.search;
  if (url.pathname === "/mcp/consent" && [...url.searchParams.keys()].every(key => key === "request") && url.searchParams.getAll("request").length === 1
    && /^[A-Za-z0-9_-]{1,256}$/.test(url.searchParams.get("request")!)) return url.pathname + url.search;
  return null;
}
/** Synchronous capture precedes auth requests, redirects and telemetry. Secret stays per tab. */
export function captureAccountLink(): string | null {
  const fragment = window.location.hash;
  if (fragment) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  const path = safeAccountReturnTo(window.location.pathname + window.location.search);
  if (!path || !["/pair", "/devices/approve"].includes(window.location.pathname)) throw new AccountTrustError("account_enrollment_invalid");
  const key = CONTINUATION + path;
  if (fragment) {
    const params = new URLSearchParams(fragment.slice(1)); const encoded = params.get("account");
    if (fragment.length > 16384 || [...params.keys()].some(name => name !== "account") || params.getAll("account").length !== 1
      || !encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new AccountTrustError("account_enrollment_invalid");
    sessionStorage.setItem(key, JSON.stringify({ encoded, capturedAt: Date.now() })); return encoded;
  }
  const raw = sessionStorage.getItem(key); if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (object(value) && typeof value.encoded === "string" && value.encoded.length <= 16384 && typeof value.capturedAt === "number"
      && Date.now() >= value.capturedAt && Date.now() - value.capturedAt < ACCOUNT_TRUST_LIMITS.enrollmentLifetimeMs) return value.encoded;
  } catch { /* Expired/malformed continuation is discarded, never treated as a new bootstrap. */ }
  sessionStorage.removeItem(key); throw new AccountTrustError("account_enrollment_expired");
}
export function clearAccountLink(): void { const path = safeAccountReturnTo(window.location.pathname + window.location.search); if (path) sessionStorage.removeItem(CONTINUATION + path); }
export function deviceApprovalUrl(link: AccountEnrollmentLink): string { return `${window.location.origin}/devices/approve#account=${encodeAccountEnrollmentLink(link)}`; }
