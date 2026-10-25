import { AccountTrustError, createAccountEnrollment, parseAccountEnrollmentRequest, parseAccountHistory, signAccountTransition, verifyAccountHistory } from "@security/account-crypto";
import { PENDING_APPROVAL_LIMITS, createPendingOffer, createPendingHello, openPendingHello, pendingOfferHash, pendingHelloHash, pendingComparisonCode, createPendingConfirmation, verifyPendingConfirmation, createPendingResult, openPendingResult, parsePendingState, signPendingAction } from "@security/pending-approval-crypto";
import type { AccountHead, AccountHistory, SignedAccountTransition } from "@security/account-protocol";
import type { PendingApprovalState, PendingApprovalSummary, PendingCandidateCommand, PendingReviewerAction, PendingReviewerCommand } from "@security/pending-approval-protocol";
import type { AccountSecurityClient, AccountSecuritySnapshot } from "./account-security-client";
import { pendingApprovalStorage, type PendingApprovalStorage, type PendingCandidateRecord, type PendingReviewerRecord } from "./pending-approval-storage";

export type PendingView = {
  status: "idle" | "waiting" | "comparing" | "confirming" | "approved" | "completed-unverified" | "awaiting-delivery-renewal" | "restart-required" | "rejected" | "cancelled" | "expired" | "conflict";
  requestId: string | null; label: string; code: string | null; offerHash?: string; localConfirmed: boolean; peerConfirmed: boolean; error: string | null; recovering?: boolean; cancellationLost?: boolean;
};
export interface PendingSnapshot { candidate: PendingView; inbox: PendingApprovalSummary[]; inboxError: string | null; inboxLoading?: boolean; review: PendingView | null }
const empty = (): PendingView => ({ status: "idle", requestId: null, label: "Browser", code: null, localConfirmed: false, peerConfirmed: false, error: null });
const terminal = (status: string) => ["rejected", "cancelled", "expired", "conflict", "restart-required"].includes(status);
class PendingCasRace extends Error {}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const equal = (left: unknown, right: unknown): boolean => {
  const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : object(value)
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
  return canonical(left) === canonical(right);
};
const accountHead = (state: NonNullable<AccountSecuritySnapshot["trust"]>): AccountHead => ({ rootId: state.checkpoint.rootId, head: state.checkpoint.head, revision: state.checkpoint.revision });
function randomToken(): string { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
function errorCode(error: unknown): string { return object(error) && typeof error.code === "string" ? error.code : "account_storage_unavailable"; }

/** Durable transcripts are authority inputs; server states are only delivery hints. */
export class PendingApprovalClient {
  private value: PendingSnapshot = { candidate: empty(), inbox: [], inboxError: null, inboxLoading: true, review: null };
  private listeners = new Set<() => void>();
  private abort = new AbortController(); private closed = false;
  private candidateWork: Promise<void> | null = null; private reviewWork: Promise<void> | null = null; private inboxWork: Promise<void> | null = null;
  private candidateAction: Promise<void> | null = null; private reviewerAction: Promise<void> | null = null;
  private selected: string | null = null; private selection = 0;
  constructor(readonly account: AccountSecurityClient, private fetcher: typeof fetch = fetch, private storage: PendingApprovalStorage = pendingApprovalStorage) {}
  snapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private active(): void { if (this.closed) throw new AccountTrustError("account_approval_required"); }
  private update(update: Partial<PendingSnapshot>): void { if (!this.closed) { this.value = { ...this.value, ...update }; for (const listener of this.listeners) listener(); } }
  private async json(path: string, body?: unknown, limit: number = PENDING_APPROVAL_LIMITS.maxWireBytes): Promise<unknown> {
    this.active(); const controller = new AbortController(); let interrupt = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => { interrupt = () => { controller.abort(); reject(new AccountTrustError("account_storage_unavailable")); }; });
    const timer = setTimeout(interrupt, PENDING_APPROVAL_LIMITS.requestTimeoutMs); this.abort.signal.addEventListener("abort", interrupt, { once: true });
    const read = async () => {
      const response = await this.fetcher.call(globalThis, path, { method: body === undefined ? "GET" : "POST", credentials: "include", redirect: "error", cache: "no-store", signal: controller.signal,
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
      if (response.status >= 500 || response.status === 429) { await response.body?.cancel(); throw new AccountTrustError("account_storage_unavailable"); }
      this.active(); let text = "";
      if (response.body) {
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let size = 0;
        try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) { await reader.cancel(); throw new AccountTrustError("account_capacity_exceeded"); } text += decoder.decode(part.value, { stream: true }); } text += decoder.decode(); }
        finally { reader.releaseLock(); }
      }
      this.active(); let value: unknown; try { value = JSON.parse(text); } catch { throw new AccountTrustError(response.status === 401 || response.status === 403 ? "account_approval_required" : "account_enrollment_invalid"); }
      if (!response.ok) {
        const error = object(value) && object(value.error) ? value.error : null;
        const code = error && typeof error.code === "string" ? error.code : response.status === 409 ? "account_trust_conflict" : response.status === 410 ? "account_enrollment_expired" : response.status >= 500 ? "account_storage_unavailable" : "account_approval_required";
        throw { code };
      }
      return value;
    };
    try { return await Promise.race([read(), interrupted]); }
    catch (error) { this.active(); if (controller.signal.aborted || error instanceof TypeError) throw new AccountTrustError("account_storage_unavailable"); throw error; }
    finally { clearTimeout(timer); this.abort.signal.removeEventListener("abort", interrupt); }
  }
  private async identity(): Promise<AccountSecuritySnapshot & { identity: NonNullable<AccountSecuritySnapshot["identity"]>; signing: NonNullable<AccountSecuritySnapshot["signing"]> }> {
    let state = this.account.snapshot(); if (!state.identity || !state.signing) state = await this.account.refresh(); this.active();
    if (!state.identity || !state.signing) throw { code: state.code ?? "account_storage_unavailable" };
    return { ...state, identity: state.identity, signing: state.signing };
  }
  private async trusted() {
    await this.account.refresh(); const state = await this.identity();
    if (state.status !== "ready" || !state.trust || state.offline) throw { code: state.code ?? "account_approval_required" };
    const member = state.trust.checkpoint.devices.find(device => equal(device.endpoint, state.identity.endpoint) && device.signingPublicKey === state.signing.publicKey);
    if (!member) throw new AccountTrustError("account_device_revoked");
    return { ...state, trust: state.trust };
  }
  private candidateKey(id: string): string { return `${this.account.ownerId}:${id}`; }
  private reviewerKey(id: string): string { return `${this.account.ownerId}:${id}`; }
  private async saveCandidate(previous: PendingCandidateRecord | null, next: PendingCandidateRecord): Promise<PendingCandidateRecord> {
    this.active(); if (!await this.storage.casCandidate(next.key, previous?.revision ?? null, next)) throw new PendingCasRace();
    this.active(); return { ...next, revision: (previous?.revision ?? 0) + 1 };
  }
  private async saveReviewer(previous: PendingReviewerRecord | null, next: PendingReviewerRecord): Promise<PendingReviewerRecord> {
    this.active(); if (!await this.storage.casReviewer(next.key, previous?.revision ?? null, next)) throw new PendingCasRace();
    this.active(); return { ...next, revision: (previous?.revision ?? 0) + 1 };
  }
  private async state(value: unknown, request: PendingApprovalState["request"], previous?: PendingApprovalState): Promise<PendingApprovalState> {
    const state = await parsePendingState(value); this.active();
    if (!equal(state.request, request) || previous && state.revision < previous.revision) throw new AccountTrustError("account_enrollment_invalid");
    const phases = ["pending", "offered", "submitted", "comparing", "confirmed", "approved"];
    if (previous && (state.revision === previous.revision && !equal(state, previous)
      || phases.includes(state.status) && phases.indexOf(state.status) < phases.indexOf(previous.status))) throw new AccountTrustError("account_enrollment_invalid");
    return state;
  }
  private async candidateSend(record: PendingCandidateRecord, path: string, body: unknown): Promise<unknown> {
    const current = await this.storage.readCandidate(record.key); this.active();
    if (current?.revision !== record.revision || ["cancelled", "completed"].includes(current.phase)) throw new PendingCasRace();
    return this.json(path, body);
  }
  private async retireOwnRequest(): Promise<void> {
    const identity = this.account.snapshot().identity; if (!identity || this.account.snapshot().status !== "ready") return;
    const key = this.candidateKey(identity.endpoint.id);
    try {
      let record = await this.storage.readCandidate(key); this.active(); if (!record) return;
      const outbound: PendingCandidateCommand | undefined = record.request && record.state
        ? { candidateToken: record.candidateToken, action: { type: "cancel", expectedRevision: record.state.revision } } : undefined;
      record = await this.saveCandidate(record, { ...record, phase: "completed", outbound });
      if (outbound && record.request) try { await this.json(`/api/security/approvals/${record.request.requestId}/candidate`, outbound); } catch { /* Obsolete remote request expires; it grants no authority. */ }
      await this.storage.casCandidate(key, record.revision, null);
    } catch { /* Durable verified trust does not depend on obsolete request cleanup. */ }
  }
  private fail(view: PendingView, error: unknown): PendingView {
    if (error instanceof PendingCasRace) return { ...view, error: null };
    const code = errorCode(error);
    return { ...view, error: code, status: code === "account_enrollment_expired" ? "expired" : code === "account_trust_conflict" ? "conflict"
      : ["account_enrollment_invalid", "invalid_account_trust", "account_trust_rollback", "account_device_revoked"].includes(code) ? "restart-required" : view.status };
  }
  ensureCandidate = (): Promise<void> => {
    if (this.candidateAction) return Promise.resolve();
    if (this.candidateWork) return this.candidateWork;
    const work = this.candidateStep().catch(error => { if (!this.closed) this.update({ candidate: this.fail(this.value.candidate, error) }); });
    this.candidateWork = work; void work.finally(() => { if (this.candidateWork === work) this.candidateWork = null; }); return work;
  };
  private async candidateStep(): Promise<void> {
    if (terminal(this.value.candidate.status) && !this.value.candidate.recovering) return;
    const identity = await this.identity();
    if (identity.status === "ready") { this.update({ candidate: { ...this.value.candidate, status: "approved", error: null } }); await this.retireOwnRequest(); return; }
    if (identity.status === "error") throw { code: identity.code };
    const key = this.candidateKey(identity.identity.endpoint.id); let record = await this.storage.readCandidate(key); this.active();
    if (!record) {
      const refreshed = await this.account.refresh(); this.active();
      if (refreshed.status === "ready") { this.update({ candidate: { ...this.value.candidate, status: "approved", error: null } }); return; }
      if (refreshed.status === "error") throw { code: refreshed.code };
      const reservation: PendingCandidateRecord = { version: 1, key, revision: 0, ownerId: this.account.ownerId, candidateId: identity.identity.endpoint.id, candidateToken: randomToken(), request: null, phase: "creating" };
      if (!await this.storage.casCandidate(key, null, reservation)) { await this.account.refresh(); await this.candidateStep(); return; }
      record = { ...reservation, revision: 1 };
      const link = await createAccountEnrollment(identity.identity, "Browser", identity.signing, null); this.active();
      if (link.request.kind !== "browser") throw new AccountTrustError("account_enrollment_invalid");
      record = await this.saveCandidate(record, { ...record, request: link.request, phase: "waiting" });
    }
    if (record.version !== 1 || record.ownerId !== this.account.ownerId || record.candidateId !== identity.identity.endpoint.id) throw new AccountTrustError("account_enrollment_invalid");
    if (record.phase === "completed") { await this.reloadCandidateOutcome(key); return; }
    if (!record.request || record.phase === "creating" || record.phase === "preparing-hello") { this.update({ candidate: { ...empty(), status: "restart-required", error: null, recovering: true } }); return; }
    const request = await parseAccountEnrollmentRequest(record.request);
    if (request.kind !== "browser" || !equal(request.candidate, identity.identity.endpoint) || request.signingPublicKey !== identity.signing.publicKey) throw new AccountTrustError("account_enrollment_invalid");
    if (terminal(record.phase)) { this.update({ candidate: { ...empty(), requestId: request.requestId, label: request.label, status: record.phase as "cancelled" } }); return; }
    let state: PendingApprovalState;
    if (record.outbound) {
      state = await this.state(await this.candidateSend(record, `/api/security/approvals/${request.requestId}/candidate`, record.outbound), request, record.state);
      record = await this.saveCandidate(record, { ...record, outbound: undefined, state });
    } else state = await this.state(await this.candidateSend(record, "/api/security/approvals", { request, candidateToken: record.candidateToken }), request, record.state);
    record = await this.saveCandidate(record, { ...record, state });
    if (terminal(state.status)) { record = await this.saveCandidate(record, { ...record, phase: state.status as "cancelled" }); this.update({ candidate: { ...empty(), requestId: request.requestId, label: request.label, status: state.status as "cancelled" } }); return; }
    const base: PendingView = { ...empty(), status: "waiting", requestId: request.requestId, label: request.label };
    if (state.status === "pending") { this.update({ candidate: base }); return; }
    const offered = await parsePendingState(state); if (!("offer" in offered)) throw new AccountTrustError("account_enrollment_invalid");
    if (!record.offer) {
      record = await this.saveCandidate(record, { ...record, offer: offered.offer, phase: "preparing-hello" });
      const hello = await createPendingHello(identity.identity, offered.offer); this.active();
      record = await this.saveCandidate(record, { ...record, hello, phase: "active" });
    }
    if (!equal(record.offer, offered.offer) || !record.hello) throw new AccountTrustError("account_enrollment_invalid");
    if (state.status === "offered") {
      const outbound: PendingCandidateCommand = { candidateToken: record.candidateToken, action: { type: "hello", expectedRevision: state.revision, hello: record.hello!.hello } };
      record = await this.saveCandidate(record, { ...record, outbound });
      state = await this.state(await this.candidateSend(record, `/api/security/approvals/${request.requestId}/candidate`, outbound), request, state);
      record = await this.saveCandidate(record, { ...record, state, outbound: undefined });
    }
    if (!("hello" in state) || !equal(state.hello, record.hello!.hello)) throw new AccountTrustError("account_enrollment_invalid");
    if (state.status === "submitted") { this.update({ candidate: base }); return; }
    if (!("reveal" in state)) throw new AccountTrustError("account_enrollment_invalid");
    const code = await pendingComparisonCode(record.offer!, record.hello!.secret, state.reveal); this.active();
    if (record.confirmedOfferHash && state.status === "comparing") {
      // Resume after a reload between the durable LOCAL click and MAC publication.
      const confirmation = await createPendingConfirmation(record.offer!, record.hello!.secret, state.reveal, record.confirmedOfferHash);
      const outbound: PendingCandidateCommand = { candidateToken: record.candidateToken, action: { type: "confirm", expectedRevision: state.revision, confirmation } };
      record = await this.saveCandidate(record, { ...record, outbound });
      state = await this.state(await this.candidateSend(record, `/api/security/approvals/${request.requestId}/candidate`, outbound), request, state);
      record = await this.saveCandidate(record, { ...record, state, outbound: undefined });
    }
    const comparing: PendingView = { ...base, status: record.confirmedOfferHash ? "confirming" : "comparing", code, offerHash: await pendingOfferHash(record.offer!), localConfirmed: !!record.confirmedOfferHash, peerConfirmed: state.status === "approved" };
    if (state.status === "approved") {
      if (!record.confirmedOfferHash) throw new AccountTrustError("account_enrollment_invalid");
      const read = await this.json("/api/security/account", undefined, 2 * 1024 * 1024 + 65536);
      if (!object(read) || !read.history) throw new AccountTrustError("invalid_account_trust");
      const history = parseAccountHistory(read.history); const readAt = Date.now();
      const result = await openPendingResult(identity.identity, record.offer!, record.hello!.secret, state.reveal, record.confirmedOfferHash, state.result, history); this.active();
      if (result.status === "awaiting-delivery-renewal") {
        if ((await this.storage.readCandidate(key))?.revision !== record.revision) { await this.reloadCandidateOutcome(key); return; }
        this.active(); this.update({ candidate: { ...comparing, status: result.status } }); return;
      }
      const committed = await this.account.acceptPendingTrust(result.trust, readAt, (previous, trust) => {
        this.active(); return this.storage.completeCandidate(record!, previous, trust);
      }); this.active();
      if (!committed) { await this.reloadCandidateOutcome(key); return; }
      this.update({ candidate: { ...comparing, status: "approved", error: null } });
      return;
    }
    this.update({ candidate: comparing });
  }
  confirmCandidate(rendered: PendingView = this.value.candidate): Promise<void> {
    if (this.candidateAction) return this.candidateAction;
    const displayed = { ...rendered };
    if (displayed.status !== "comparing" || !displayed.requestId || !displayed.offerHash || !displayed.code) return Promise.resolve();
    const work = (async () => { await this.candidateWork; await this.performCandidateConfirmation(displayed); })()
      .catch(error => { if (!this.closed) this.update({ candidate: this.fail(this.value.candidate, error) }); }); this.candidateAction = work;
    void work.finally(() => { if (this.candidateAction === work) this.candidateAction = null; }).catch(() => {}); return work;
  }
  private async performCandidateConfirmation(displayed: PendingView): Promise<void> {
    const identity = await this.identity(); const key = this.candidateKey(identity.identity.endpoint.id); let record = await this.storage.readCandidate(key); this.active();
    if (!record?.offer || !record.hello || !record.state || !("reveal" in record.state) || record.request?.requestId !== displayed.requestId || record.phase !== "active") { await this.candidateStep(); return; }
    const offerHash = await pendingOfferHash(record.offer);
    if (offerHash !== displayed.offerHash || await pendingComparisonCode(record.offer, record.hello.secret, record.state.reveal) !== displayed.code) { await this.candidateStep(); return; }
    // Only this explicit local event records positive comparison, before making a MAC.
    let saved = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await this.storage.readCandidate(key); this.active();
      if (!current?.offer || !current.hello || current.phase !== "active" || current.request?.requestId !== displayed.requestId || !equal(current.offer, record.offer) || !equal(current.hello.hello, record.hello.hello)) { await this.candidateStep(); return; }
      if (await this.storage.casCandidate(key, current.revision, { ...current, confirmedOfferHash: offerHash })) { saved = true; break; }
    }
    if (!saved) throw new PendingCasRace();
    await this.candidateStep();
  }
  private async reloadCandidateOutcome(key: string, cancellationLost = false): Promise<boolean> {
    const current = await this.storage.readCandidate(key); this.active();
    if (!current || current.phase === "completed") {
      const committed = current?.phase === "completed" || await this.account.hasCommittedTrust(); this.active();
      const account = await this.account.refresh(); this.active();
      if (account.status === "ready") { this.update({ candidate: { ...this.value.candidate, status: "approved", error: null, cancellationLost } }); return true; }
      if (committed) { this.update({ candidate: { ...this.value.candidate, status: "completed-unverified", code: null, error: account.code, cancellationLost } }); return true; }
    }
    if (current && terminal(current.phase)) this.update({ candidate: { ...empty(), requestId: current.request?.requestId ?? null, label: current.request?.label ?? "Browser", status: current.phase as "cancelled" } });
    return false;
  }
  async cancelCandidate(): Promise<void> {
    const identity = await this.identity(); const key = this.candidateKey(identity.identity.endpoint.id);
    for (let attempt = 0; attempt < 8; attempt++) {
      const record = await this.storage.readCandidate(key); this.active();
      if (!record || record.phase === "completed") {
        if (await this.reloadCandidateOutcome(key, true)) return;
        this.update({ candidate: { ...this.value.candidate, status: "cancelled", error: null } }); return;
      }
      if (!await this.storage.casCandidate(key, record.revision, { ...record, phase: "cancelled", outbound: undefined })) continue;
      this.active(); this.update({ candidate: { ...this.value.candidate, status: "cancelled", code: null, error: null } });
      if (record.request && record.state) try { await this.json(`/api/security/approvals/${record.request.requestId}/candidate`, { candidateToken: record.candidateToken, action: { type: "cancel", expectedRevision: record.state.revision } }); } catch { /* Local cancellation remains final even if the relay is unavailable. */ }
      return;
    }
    await this.reloadCandidateOutcome(key); throw new PendingCasRace();
  }
  async restartCandidate(): Promise<void> {
    await this.cancelCandidate(); if (this.value.candidate.status !== "cancelled") return;
    const identity = await this.identity(); const key = this.candidateKey(identity.identity.endpoint.id); const record = await this.storage.readCandidate(key);
    this.active(); if (record && !await this.storage.casCandidate(key, record.revision, null)) throw new AccountTrustError("account_trust_conflict");
    this.update({ candidate: empty() }); await this.ensureCandidate();
  }
  refreshInbox = (): Promise<void> => {
    if (this.inboxWork) return this.inboxWork;
    const work = this.readInbox().catch(error => this.update({ inboxError: errorCode(error), inboxLoading: false })); this.inboxWork = work;
    void work.finally(() => { if (this.inboxWork === work) this.inboxWork = null; }); return work;
  };
  private async readInbox(): Promise<void> {
    if (this.value.inboxError === "account_approval_required") await this.trusted();
    const current = this.account.snapshot(); if (current.status !== "ready") { this.update({ inbox: [], inboxError: null, inboxLoading: false }); return; }
    await this.retireOwnRequest();
    const raw = await this.json("/api/security/approvals", undefined, PENDING_APPROVAL_LIMITS.maxInboxBytes);
    if (!object(raw) || Object.keys(raw).join() !== "requests" || !Array.isArray(raw.requests) || raw.requests.length > PENDING_APPROVAL_LIMITS.maxPendingPerTarget) throw new AccountTrustError("account_enrollment_invalid");
    const requests: PendingApprovalSummary[] = [];
    for (const value of raw.requests) {
      if (!object(value) || Object.keys(value).sort().join() !== "request,revision,status" || typeof value.status !== "string" || !["pending", "offered", "submitted", "comparing", "confirmed", "approved", "rejected", "cancelled", "expired", "conflict"].includes(value.status)
        || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw new AccountTrustError("account_enrollment_invalid");
      const request = await parseAccountEnrollmentRequest(value.request, terminal(value.status) && object(value.request) ? Date.parse(String(value.request.expiresAt)) - 1 : Date.now());
      if (request.kind === "browser" && request.candidate.ownerId !== this.account.ownerId) throw new AccountTrustError("account_enrollment_invalid");
      if (request.kind === "browser" && current.trust?.checkpoint.devices.some(device => equal(device.endpoint, request.candidate) && device.signingPublicKey === request.signingPublicKey) && request.candidate.id === current.identity?.endpoint.id) continue;
      requests.push({ request, revision: Number(value.revision), status: value.status as PendingApprovalState["status"] });
    }
    this.active(); this.update({ inbox: requests, inboxError: null, inboxLoading: false });
  }
  async review(requestId: string): Promise<void> {
    this.selected = requestId; this.selection++; this.update({ review: { ...empty(), requestId, status: "waiting" } }); await this.pollReview();
  }
  dismissReview(): void { this.selected = null; this.selection++; this.update({ review: null }); }
  pollReview = (): Promise<void> => {
    if (this.reviewerAction) return Promise.resolve();
    if (this.reviewWork) return this.reviewWork;
    const selected = this.selected; const generation = this.selection;
    const work = (selected ? this.reviewStep(selected, generation) : Promise.resolve()).catch(error => { if (generation === this.selection && !this.closed && this.value.review) this.update({ review: this.fail(this.value.review, error) }); });
    this.reviewWork = work; void work.finally(() => { if (this.reviewWork === work) this.reviewWork = null; }); return work;
  };
  private reviewActive(generation: number): void { this.active(); if (generation !== this.selection) throw new PendingCasRace(); }
  private showReview(view: PendingView, generation: number): void { if (generation === this.selection) this.update({ review: view }); }
  private async command(record: PendingReviewerRecord, state: PendingApprovalState, action: PendingReviewerAction, generation?: number): Promise<PendingReviewerRecord> {
    if ((await this.storage.readReviewer(record.key))?.revision !== record.revision) throw new PendingCasRace();
    const trusted = await this.trusted(); if (generation !== undefined) this.reviewActive(generation);
    if ((await this.storage.readReviewer(record.key))?.revision !== record.revision) throw new PendingCasRace();
    if (record.local && !["reject", "renew"].includes(action.type) && !equal(accountHead(trusted.trust), record.local.offer.payload.anchor)) throw new AccountTrustError("account_trust_conflict");
    const outbound = await signPendingAction({ type: "ftown_pending_action", version: 1, requestId: state.request.requestId, ownerId: this.account.ownerId, signerId: trusted.identity.endpoint.id,
      head: accountHead(trusted.trust), expectedRevision: state.revision, issuedAt: new Date().toISOString(), action }, trusted.signing);
    if (generation !== undefined) this.reviewActive(generation);
    return this.saveReviewer(record, { ...record, outbound });
  }
  private async publish(record: PendingReviewerRecord, generation?: number): Promise<{ record: PendingReviewerRecord; state: PendingApprovalState }> {
    if (!record.outbound) throw new AccountTrustError("account_enrollment_invalid");
    await this.trusted(); this.active(); if (generation !== undefined) this.reviewActive(generation);
    const current = await this.storage.readReviewer(record.key); this.active(); if (generation !== undefined) this.reviewActive(generation);
    if (current?.revision !== record.revision || !equal(current.outbound, record.outbound)) throw new PendingCasRace();
    const state = await this.state(await this.json(`/api/security/approvals/${record.request.requestId}`, record.outbound), record.request, record.state);
    const action = record.outbound.payload.action;
    if ((action.type === "finish" || action.type === "renew") && (state.status !== "approved" || !equal(state.result, action.result))
      || action.type === "review" && (!("offer" in state) || !equal(state.offer, action.offer))
      || action.type === "reveal" && (!("reveal" in state) || !equal(state.reveal, action.reveal))
      || action.type === "reject" && state.status !== "rejected") throw new AccountTrustError("account_enrollment_invalid");
    return { record: await this.saveReviewer(record, { ...record, outbound: undefined, state }), state };
  }
  private async reviewStep(requestId: string, generation: number): Promise<void> {
    if (this.value.review && terminal(this.value.review.status) && !this.value.review.recovering) return;
    if (this.value.review?.error === "account_approval_required") await this.trusted();
    const key = this.reviewerKey(requestId); let record = await this.storage.readReviewer(key); this.reviewActive(generation);
    if (record?.phase === "burned") { this.showReview({ ...empty(), requestId, status: "rejected", error: "account_enrollment_invalid" }, generation); return; }
    if (record && Date.parse(record.request.expiresAt) <= Date.now() && record.state?.status === "approved") { this.showReview({ ...empty(), requestId, status: "approved" }, generation); return; }
    let state = await parsePendingState(await this.json(`/api/security/approvals/${requestId}`)); this.reviewActive(generation);
    if (state.request.requestId !== requestId || state.request.kind === "browser" && state.request.candidate.ownerId !== this.account.ownerId) throw new AccountTrustError("account_enrollment_invalid");
    if (record && !equal(record.request, state.request)) throw new AccountTrustError("account_enrollment_invalid");
    if (record?.state) state = await this.state(state, record.request, record.state);
    if (record?.outbound) ({ record, state } = await this.publish(record, generation));
    const base: PendingView = { ...empty(), requestId, label: state.request.label, status: "waiting" };
    if (terminal(state.status)) { this.showReview({ ...base, status: state.status as "cancelled" }, generation); return; }
    if (!record) {
      if (state.status !== "pending") { this.showReview({ ...base, status: "restart-required", error: "account_storage_unavailable" }, generation); return; }
      const reservation: PendingReviewerRecord = { version: 1, key, revision: 0, ownerId: this.account.ownerId, request: state.request, phase: "creating-offer", state };
      if (!await this.storage.casReviewer(key, null, reservation)) return;
      record = { ...reservation, revision: 1 };
      const trusted = await this.trusted(); const local = await createPendingOffer(state.request, trusted.identity, trusted.signing, trusted.trust.history); this.reviewActive(generation);
      record = await this.saveReviewer(record, { ...record, local, phase: "active" });
      record = await this.command(record, state, { type: "review", offer: local.offer }, generation);
      ({ record, state } = await this.publish(record, generation));
    }
    if (!record.local || record.phase === "creating-offer" || record.phase === "opening-hello") { this.showReview({ ...base, status: "restart-required", error: null, recovering: true }, generation); return; }
    if (state.status === "pending") {
      const trusted = await this.trusted(); this.reviewActive(generation);
      if (!equal(accountHead(trusted.trust), record.local.offer.payload.anchor)) throw new AccountTrustError("account_trust_conflict");
      record = await this.command(record, state, { type: "review", offer: record.local.offer }, generation);
      ({ record, state } = await this.publish(record, generation));
    }
    if (!record.local || !("offer" in state) || !equal(state.offer, record.local.offer)) throw new AccountTrustError("account_enrollment_invalid");
    record = await this.saveReviewer(record, { ...record, state });
    if (state.status === "offered") { this.showReview(base, generation); return; }
    if (!("hello" in state)) throw new AccountTrustError("account_enrollment_invalid");
    const helloHash = await pendingHelloHash(state.hello); this.reviewActive(generation);
    if (record.helloHash && record.helloHash !== helloHash) throw new AccountTrustError("account_enrollment_invalid");
    if (!record.opened) {
      record = await this.saveReviewer(record, { ...record, helloHash, phase: "opening-hello" });
      try {
        const secret = await openPendingHello((await this.identity()).identity, record.local!, state.hello); this.reviewActive(generation);
        const opened = { secret, helloHash, offerHash: await pendingOfferHash(record.local!.offer), openedAt: Date.now() };
        record = await this.saveReviewer(record, { ...record, opened, phase: "active" });
      } catch (error) {
        // Persist consumption even when the subsequent signed rejection cannot reach the server.
        record = await this.saveReviewer(record, { ...record, phase: "burned" });
        try { record = await this.command(record, state, { type: "reject" }, generation); await this.publish(record, generation); } catch { /* Burn is durable locally. */ }
        throw error;
      }
    }
    if (state.status === "submitted") {
      const offerHash = record.opened!.offerHash; const reveal = { offerHash, contribution: record.local!.contribution };
      record = await this.command(record, state, { type: "reveal", offerHash, helloHash, reveal }, generation);
      ({ record, state } = await this.publish(record, generation));
    }
    if (!("reveal" in state) || !record.opened) throw new AccountTrustError("account_enrollment_invalid");
    const code = await pendingComparisonCode(record.local!.offer, record.opened!.secret, state.reveal); this.reviewActive(generation);
    const view: PendingView = { ...base, status: record.confirmedOfferHash ? "confirming" : "comparing", code, offerHash: record.opened.offerHash, localConfirmed: !!record.confirmedOfferHash, peerConfirmed: "confirmation" in state };
    if (state.status === "confirmed" && record.confirmedOfferHash) {
      await verifyPendingConfirmation(record.local!.offer, record.opened!.secret, state.reveal, state.confirmation);
      const trusted = await this.trusted();
      if (!equal(accountHead(trusted.trust), record.local!.offer.payload.anchor)) throw new AccountTrustError("account_trust_conflict");
      let transition: SignedAccountTransition | null = null; let history = trusted.trust.history;
      const request = state.request;
      const existing = request.kind === "browser" ? trusted.trust.checkpoint.devices.some(device => device.endpoint.id === request.candidate.id)
        : trusted.trust.checkpoint.bridges.some(bridge => bridge.bridgeId === request.bridgeId);
      if (!existing) {
        const approvedAt = new Date().toISOString();
        transition = await signAccountTransition(trusted.trust.checkpoint, trusted.identity.endpoint.id, trusted.signing, request.kind === "browser"
          ? { type: "add_device", device: { endpoint: request.candidate, signingPublicKey: request.signingPublicKey, label: request.label, approvedAt } }
          : { type: "add_bridge", bridge: { bridgeId: request.bridgeId, endpoint: { ...request.candidate, ownerId: this.account.ownerId }, label: request.label, approvedAt } });
        history = { ...history, transitions: [...history.transitions, transition] };
      }
      const result = await createPendingResult(trusted.identity, record.local!, record.opened!.secret, state.confirmation, record.confirmedOfferHash!, history); this.reviewActive(generation);
      record = await this.saveReviewer(record, { ...record, approvalHistory: history, result });
      record = await this.command(record, state, { type: "finish", offerHash: record.opened!.offerHash, transition, result }, generation);
      ({ record, state } = await this.publish(record, generation));
      await this.account.refresh();
    }
    if (state.status === "approved") {
      if (!record.confirmedOfferHash || !record.approvalHistory || !equal(state.result, record.result)) throw new AccountTrustError("account_enrollment_invalid");
      await verifyPendingConfirmation(record.local!.offer, record.opened!.secret, state.reveal, state.confirmation);
      const prefix = await verifyAccountHistory(record.approvalHistory, null);
      if (!equal(state.result.head, { rootId: prefix.rootId, revision: prefix.revision, head: prefix.head })) throw new AccountTrustError("account_enrollment_invalid");
      if (state.result.bundle.envelope.expiresAt - Date.now() < 15000) {
        const trusted = await this.trusted();
        const current = trusted.trust.checkpoint; const request = state.request;
        if (request.kind === "browser" ? !current.devices.some(device => equal(device.endpoint, request.candidate) && device.signingPublicKey === request.signingPublicKey)
          : !current.bridges.some(bridge => bridge.bridgeId === request.bridgeId && bridge.endpoint.publicKey === request.candidate.publicKey)) throw new AccountTrustError("account_device_revoked");
        const result = await createPendingResult(trusted.identity, record.local!, record.opened!.secret, state.confirmation, record.confirmedOfferHash, record.approvalHistory);
        record = await this.saveReviewer(record, { ...record, result });
        record = await this.command(record, state, { type: "renew", offerHash: record.opened!.offerHash, result }, generation);
        ({ record, state } = await this.publish(record, generation));
      }
      this.showReview({ ...view, status: "approved", error: null }, generation); return;
    }
    this.showReview(view, generation);
  }
  confirmReview(rendered: PendingView | null = this.value.review): Promise<void> {
    if (this.reviewerAction) return this.reviewerAction;
    const generation = this.selection;
    const displayed = rendered && { ...rendered };
    if (!displayed || displayed.status !== "comparing" || !displayed.requestId || !displayed.offerHash || !displayed.code) return Promise.resolve();
    const work = (async () => { await this.reviewWork; this.reviewActive(generation); await this.performReviewConfirmation(displayed, generation); })()
      .catch(error => { if (!this.closed && generation === this.selection && this.value.review) this.update({ review: this.fail(this.value.review, error) }); }); this.reviewerAction = work;
    void work.finally(() => { if (this.reviewerAction === work) this.reviewerAction = null; }).catch(() => {}); return work;
  }
  private async performReviewConfirmation(displayed: PendingView, generation: number): Promise<void> {
    if (this.selected !== displayed.requestId) return;
    const selected = displayed.requestId!;
    await this.trusted(); const key = this.reviewerKey(selected); const record = await this.storage.readReviewer(key); this.reviewActive(generation);
    if (!record?.local || !record.opened || !record.state || !("reveal" in record.state)) throw new AccountTrustError("account_enrollment_invalid");
    const offerHash = await pendingOfferHash(record.local.offer); this.reviewActive(generation);
    if (offerHash !== displayed.offerHash || await pendingComparisonCode(record.local.offer, record.opened.secret, record.state.reveal) !== displayed.code) { await this.reviewStep(selected, generation); return; }
    let saved = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await this.storage.readReviewer(key); this.reviewActive(generation);
      if (!current?.local || !current.opened || current.phase !== "active" || !equal(current.local.offer, record.local.offer)) throw new AccountTrustError("account_enrollment_invalid");
      if (await this.storage.casReviewer(key, current.revision, { ...current, confirmedOfferHash: offerHash })) { saved = true; break; }
    }
    if (!saved) throw new PendingCasRace();
    await this.reviewStep(selected, generation);
  }
  reject(requestId: string): Promise<void> {
    if (this.reviewerAction) return this.reviewerAction;
    const work = (async () => { await this.reviewWork; await this.performReject(requestId); })(); this.reviewerAction = work;
    void work.finally(() => { if (this.reviewerAction === work) this.reviewerAction = null; }).catch(() => {}); return work;
  }
  private async performReject(requestId: string): Promise<void> {
    await this.trusted(); const state = await parsePendingState(await this.json(`/api/security/approvals/${requestId}`));
    if (state.request.requestId !== requestId) throw new AccountTrustError("account_enrollment_invalid");
    const key = this.reviewerKey(requestId); let record = await this.storage.readReviewer(key); this.active();
    if (!record) record = await this.saveReviewer(null, { version: 1, key, revision: 0, ownerId: this.account.ownerId, request: state.request, phase: "rejected", state });
    else record = await this.saveReviewer(record, { ...record, phase: "rejected" });
    record = await this.command(record, state, { type: "reject" }); await this.publish(record);
    if (this.selected === requestId) this.update({ review: { ...empty(), requestId, status: "rejected" } });
    await this.refreshInbox();
  }
  dispose(): void { this.closed = true; this.selection++; this.abort.abort(); this.listeners.clear(); }
}
