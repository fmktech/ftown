// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateEndpoint } from "@security/crypto";
import { createAccountEnrollment, createAccountGenesis, generateAccountSigningIdentity, signAccountTransition, verifyAccountHistory } from "@security/account-crypto";
import { createPendingOffer, pendingOfferHash, verifyPendingAction } from "@security/pending-approval-crypto";
import type { AccountHistory, StoredAccountTrust } from "@security/account-protocol";
import type { PendingApprovalState, PendingBrowserCreate, PendingCandidateCommand, PendingReviewerCommand } from "@security/pending-approval-protocol";
import { AccountSecurityClient, accountStorage } from "./account-security-client";
import { sameAccountTrustPin } from "./browser-identity";
import { sameCandidateCompletion } from "./pending-approval-storage";
import { PendingApprovalClient } from "./pending-approval-client";
import type { PendingApprovalStorage, PendingCandidateRecord, PendingReviewerRecord } from "./pending-approval-storage";
const owner = "00000000-0000-4000-8000-000000000001";
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
function memory(commit: (trust: StoredAccountTrust) => void = () => {}, pin: () => StoredAccountTrust | null = () => null) {
  const candidates = new Map<string, PendingCandidateRecord>(); const reviewers = new Map<string, PendingReviewerRecord>();
  function cas<T extends { revision: number }>(map: Map<string, T>, key: string, expected: number | null, next: T | null) {
    if ((map.get(key)?.revision ?? null) !== expected) return false;
    if (next) map.set(key, structuredClone({ ...next, revision: (expected ?? 0) + 1 })); else map.delete(key); return true;
  }
  const storage: PendingApprovalStorage = { readCandidate: async key => structuredClone(candidates.get(key) ?? null), readReviewer: async key => structuredClone(reviewers.get(key) ?? null),
    casCandidate: async (key, rev, value) => cas(candidates, key, rev, value), casReviewer: async (key, rev, value) => cas(reviewers, key, rev, value),
    completeCandidate: async (expected, previous, trust) => {
      if (!sameCandidateCompletion(candidates.get(expected.key) ?? null, expected) || !sameAccountTrustPin(pin(), previous)) return false;
      commit(trust); cas(candidates, expected.key, expected.revision, { ...expected, phase: "completed", outbound: undefined }); return true;
    } };
  return { storage, candidates, reviewers };
}
async function fixture() {
  const trustedIdentity = await generateEndpoint(owner, "browser", false); const trustedSigning = await generateAccountSigningIdentity(false);
  let history: AccountHistory = { genesis: await createAccountGenesis(owner, trustedIdentity.endpoint, trustedSigning, "Laptop"), transitions: [] };
  const states = new Map<string, PendingApprovalState>(); const credentials = new Map<string, string>(); const committed = new Map<string, PendingApprovalState>();
  const commands: PendingReviewerCommand[] = []; const candidateCommands: PendingCandidateCommand[] = [];
  let loseFinish = false; let failReject = false; let loseCreate = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/api/security/account") return response({ history });
    if (path === "/api/security/approvals") {
      if (body) {
        const create = body as PendingBrowserCreate; const id = create.request.requestId;
        if (!states.has(id)) { states.set(id, { request: create.request, revision: 0, status: "pending" }); credentials.set(id, create.candidateToken); }
        if (loseCreate) { loseCreate = false; throw new TypeError("lost create reply"); }
        return response(states.get(id));
      }
      return response({ requests: [...states.values()].map(({ request, revision, status }) => ({ request, revision, status })) });
    }
    const id = path.split("/")[4]; const current = states.get(id); if (!current) throw new Error("unknown test request");
    if (!body) return response(current);
    if (path.endsWith("/candidate")) {
      const command = body as PendingCandidateCommand; candidateCommands.push(command); expect(command.candidateToken === credentials.get(id)).toBe(true);
      const action = command.action; if (action.type === "read") return response(current);
      if (action.type === "cancel" && current.status === "approved") return new Response(JSON.stringify({ error: { code: "account_trust_conflict" } }), { status: 409 });
      if (action.type === "cancel") { const next: PendingApprovalState = { request: current.request, revision: current.revision + 1, status: "cancelled" }; states.set(id, next); return response(next); }
      if (action.type === "hello" && current.status === "offered") { const next: PendingApprovalState = { ...current, revision: current.revision + 1, status: "submitted", hello: action.hello }; states.set(id, next); return response(next); }
      if (action.type === "confirm" && current.status === "comparing") { const next: PendingApprovalState = { ...current, revision: current.revision + 1, status: "confirmed", confirmation: action.confirmation }; states.set(id, next); return response(next); }
      // Exact retry sees the already committed state.
      return response(current);
    }
    const command = body as PendingReviewerCommand; commands.push(command); const digest = JSON.stringify(command);
    if (committed.has(digest)) return response(committed.get(digest));
    await verifyPendingAction(command, current.request, history);
    const action = command.payload.action; let next: PendingApprovalState;
    if (action.type === "review" && current.status === "pending") next = { ...current, revision: current.revision + 1, status: "offered", offer: action.offer };
    else if (action.type === "reveal" && current.status === "submitted") next = { ...current, revision: current.revision + 1, status: "comparing", reveal: action.reveal };
    else if (action.type === "finish" && current.status === "confirmed") {
      if (action.transition) history = { ...history, transitions: [...history.transitions, action.transition] };
      await verifyAccountHistory(history, null); next = { ...current, revision: current.revision + 1, status: "approved", result: action.result };
    } else if (action.type === "renew" && current.status === "approved") next = { ...current, revision: current.revision + 1, result: action.result };
    else if (action.type === "reject") { if (failReject) throw new TypeError("reject unavailable"); next = { request: current.request, revision: current.revision + 1, status: "rejected" }; }
    else throw new Error("unexpected test transition");
    states.set(id, next); committed.set(digest, next);
    if (action.type === "finish" && loseFinish) { loseFinish = false; throw new TypeError("lost committed final response"); }
    return response(next);
  }) as unknown as typeof fetch;
  async function installation(trusted: boolean) {
    const identity = trusted ? trustedIdentity : await generateEndpoint(owner, "browser", false); const signing = trusted ? trustedSigning : await generateAccountSigningIdentity(false);
    let stored: StoredAccountTrust | null = trusted ? { history, checkpoint: await verifyAccountHistory(history, null), lastServerReadAt: Date.now(), lastObservedAt: Date.now() } : null;
    const storage: typeof accountStorage = { loadBrowserIdentity: async () => identity, loadAccountSigningIdentity: async () => signing, readAccountTrust: async () => stored, readPinnedBridges: async () => [],
      readAccountEnrollment: async () => null, storeAccountEnrollment: async () => {}, clearAccountEnrollment: async () => {},
      persistAccountTrust: async (_owner, verified, options = {}) => { const checkpoint = await verifyAccountHistory(verified.history, stored?.checkpoint ?? null); stored = { history: verified.history, checkpoint, lastServerReadAt: options.serverReadAt ?? stored?.lastServerReadAt ?? 0, lastObservedAt: Date.now() }; return stored; } };
    const account = new AccountSecurityClient(owner, fetcher, storage); await account.refresh(); const local = memory(trust => { stored = trust; }, () => stored);
    const client = new PendingApprovalClient(account, fetcher, local.storage);
    return { account, client, local, storage, stored: () => stored, identity, signing };
  }
  return { fetcher, states, commands, candidateCommands, installation, history: () => history, setHistory: (next: AccountHistory) => { history = next; }, loseFinish: () => { loseFinish = true; }, loseCreate: () => { loseCreate = true; }, failReject: () => { failReject = true; } };
}
async function comparing() {
  const f = await fixture(); const candidate = await f.installation(false); const reviewer = await f.installation(true);
  await candidate.client.ensureCandidate(); const id = candidate.client.snapshot().candidate.requestId!;
  await reviewer.client.review(id); await candidate.client.ensureCandidate(); await reviewer.client.pollReview(); await candidate.client.ensureCandidate();
  expect(candidate.client.snapshot().candidate.status).toBe("comparing"); expect(reviewer.client.snapshot().review?.status).toBe("comparing");
  return { ...f, candidate, reviewer, id };
}

it("requires both explicit local confirmations before a real signed membership and durable trust", async () => {
  const f = await comparing(); expect(f.candidate.client.snapshot().candidate.code).toBe(f.reviewer.client.snapshot().review!.code);
  const local = [...f.candidate.local.candidates.values()][0]; const opened = [...f.reviewer.local.reviewers.values()][0].opened!;
  expect(local.hello!.secret.key.extractable).toBe(false); expect(opened.secret.key.extractable).toBe(false);
  await f.reviewer.client.confirmReview(); await f.reviewer.client.pollReview();
  expect(f.history().transitions).toHaveLength(0); expect(f.candidate.stored()).toBeNull();
  await f.candidate.client.confirmCandidate(); expect(f.candidate.stored()).toBeNull();
  await f.reviewer.client.pollReview(); await f.candidate.client.ensureCandidate();
  expect(f.history().transitions).toHaveLength(1); expect(f.candidate.account.snapshot().status).toBe("ready"); expect(f.candidate.stored()).not.toBeNull();
});

it("resumes the exact durable request and hello after reload and a lost create reply", async () => {
  const f = await fixture(); const candidate = await f.installation(false); f.loseCreate(); await candidate.client.ensureCandidate();
  const first = [...candidate.local.candidates.values()][0]; expect(first.request).not.toBeNull();
  candidate.client.dispose(); const resumed = new PendingApprovalClient(candidate.account, f.fetcher, candidate.local.storage);
  await resumed.ensureCandidate(); expect(resumed.snapshot().candidate.requestId).toBe(first.request!.requestId); expect(f.states.size).toBe(1);
  const reviewer = await f.installation(true); await reviewer.client.review(first.request!.requestId); await resumed.ensureCandidate();
  const hello = [...candidate.local.candidates.values()][0].hello!;
  resumed.dispose(); const afterReload = new PendingApprovalClient(candidate.account, f.fetcher, candidate.local.storage); await afterReload.ensureCandidate();
  expect([...candidate.local.candidates.values()][0].hello!.hello).toEqual(hello.hello);
  expect(f.candidateCommands.filter(command => command.action.type === "hello")).toHaveLength(1);
});

it("replays the exact committed final action after response loss without another roster addition", async () => {
  const f = await comparing(); await f.candidate.client.confirmCandidate(); f.loseFinish(); await f.reviewer.client.confirmReview();
  expect(f.history().transitions).toHaveLength(1); expect([...f.reviewer.local.reviewers.values()][0].outbound?.payload.action.type).toBe("finish");
  await f.reviewer.client.pollReview(); await f.candidate.client.ensureCandidate();
  expect(f.history().transitions).toHaveLength(1); expect(f.candidate.account.snapshot().status).toBe("ready");
  const finals = f.commands.filter(command => command.payload.action.type === "finish"); expect(finals).toHaveLength(2); expect(finals[1]).toEqual(finals[0]);
});

it("a relay confirmed state cannot substitute for the candidate's local comparison", async () => {
  const f = await comparing(); await f.reviewer.client.confirmReview();
  const state = f.states.get(f.id)!; if (state.status !== "comparing") throw new Error("bad test setup");
  f.states.set(f.id, { ...state, status: "confirmed", confirmation: { offerHash: "A".repeat(43), mac: "A".repeat(43) } });
  await f.candidate.client.ensureCandidate(); await f.reviewer.client.pollReview();
  expect(f.candidate.stored()).toBeNull(); expect(f.history().transitions).toHaveLength(0);
});

it("burns the pinned hello on authentication failure even when signed reject cannot publish", async () => {
  const f = await fixture(); const candidate = await f.installation(false); const reviewer = await f.installation(true);
  await candidate.client.ensureCandidate(); const id = candidate.client.snapshot().candidate.requestId!; await reviewer.client.review(id); await candidate.client.ensureCandidate();
  const state = f.states.get(id)!; if (state.status !== "submitted") throw new Error("bad test setup");
  state.hello.envelope.ciphertext = (state.hello.envelope.ciphertext[0] === "A" ? "B" : "A") + state.hello.envelope.ciphertext.slice(1); f.failReject();
  await reviewer.client.pollReview(); expect([...reviewer.local.reviewers.values()][0].phase).toBe("burned");
  const commands = f.commands.length; reviewer.client.dispose(); const resumed = new PendingApprovalClient(reviewer.account, f.fetcher, reviewer.local.storage);
  await resumed.review(id); expect(resumed.snapshot().review?.status).toBe("rejected"); expect(f.commands).toHaveLength(commands); expect(f.history().transitions).toHaveLength(0);
});

it("reload renews expired delivery using retained reviewer key and immutable approved prefix", async () => {
  const f = await comparing(); await f.candidate.client.confirmCandidate(); await f.reviewer.client.confirmReview();
  const approved = f.states.get(f.id)!; if (approved.status !== "approved") throw new Error("bad test setup");
  const head = approved.result.head; const code = f.candidate.client.snapshot().candidate.code;
  f.reviewer.client.dispose(); const now = approved.result.bundle.envelope.expiresAt + 1; vi.spyOn(Date, "now").mockReturnValue(now);
  await f.candidate.client.ensureCandidate(); expect(f.candidate.client.snapshot().candidate.status).toBe("awaiting-delivery-renewal");
  const resumed = new PendingApprovalClient(f.reviewer.account, f.fetcher, f.reviewer.local.storage); await resumed.review(f.id);
  expect(f.commands.at(-1)!.payload.action.type).toBe("renew"); const renewed = f.states.get(f.id)!;
  expect(renewed.status === "approved" && renewed.result.head).toEqual(head); expect(f.history().transitions).toHaveLength(1);
  await f.candidate.client.ensureCandidate(); expect(f.candidate.account.snapshot().status).toBe("ready"); expect(f.candidate.client.snapshot().candidate.code).toBe(code);
});

it("two tabs select one candidate request and one reviewer offer without replacing hidden state", async () => {
  const f = await fixture(); const candidate = await f.installation(false);
  const other = new PendingApprovalClient(candidate.account, f.fetcher, candidate.local.storage);
  await Promise.all([candidate.client.ensureCandidate(), other.ensureCandidate()]); await other.ensureCandidate();
  expect(f.states.size).toBe(1); expect(candidate.local.candidates.size).toBe(1);
  const reviewer = await f.installation(true); const secondReview = new PendingApprovalClient(reviewer.account, f.fetcher, reviewer.local.storage);
  const id = [...f.states.keys()][0]; await Promise.all([reviewer.client.review(id), secondReview.review(id)]); await secondReview.pollReview();
  expect(f.commands.filter(command => command.payload.action.type === "review")).toHaveLength(1); expect(reviewer.local.reviewers.size).toBe(1);
});


it("a changed signed anchor requires fresh verification rather than retargeting the existing comparison", async () => {
  const f = await comparing(); const initial = f.history(); const checkpoint = await verifyAccountHistory(initial, null);
  const endpoint = await generateEndpoint(owner, "browser", false); const signing = await generateAccountSigningIdentity(false);
  const transition = await signAccountTransition(checkpoint, f.reviewer.identity.endpoint.id, f.reviewer.signing,
    { type: "add_device", device: { endpoint: endpoint.endpoint, signingPublicKey: signing.publicKey, label: "Other device", approvedAt: new Date().toISOString() } });
  f.setHistory({ ...initial, transitions: [transition] });
  await f.candidate.client.confirmCandidate(); await f.reviewer.client.confirmReview();
  expect(f.reviewer.client.snapshot().review!.status).toBe("conflict"); expect(f.history().transitions).toHaveLength(1);
  expect(f.commands.filter(command => command.payload.action.type === "finish")).toHaveLength(0); expect(f.candidate.stored()).toBeNull();
});

it("missing retained candidate secret never generates a replacement hello under the pinned offer", async () => {
  const f = await comparing(); const record = [...f.candidate.local.candidates.values()][0];
  f.candidate.local.candidates.set(record.key, { ...record, hello: undefined }); f.candidate.client.dispose();
  const resumed = new PendingApprovalClient(f.candidate.account, f.fetcher, f.candidate.local.storage);
  const before = f.candidateCommands.filter(command => command.action.type === "hello").length;
  await resumed.ensureCandidate(); expect(resumed.snapshot().candidate.status).toBe("restart-required");
  expect(f.candidateCommands.filter(command => command.action.type === "hello")).toHaveLength(before); expect(f.candidate.stored()).toBeNull();
  await resumed.restartCandidate();
  expect(resumed.snapshot().candidate.requestId).not.toBe(f.id);
  expect([...f.candidate.local.candidates.values()][0].candidateId).toBe(f.candidate.identity.endpoint.id);
});

it("bootstrap-established trust retires its obsolete own request without another approval", async () => {
  const f = await fixture(); const trusted = await f.installation(true);
  const link = await createAccountEnrollment(trusted.identity, "First browser", trusted.signing, null);
  if (link.request.kind !== "browser") throw new Error("bad test setup");
  const candidateToken = "B".repeat(43);
  await f.fetcher("/api/security/approvals", { method: "POST", body: JSON.stringify({ request: link.request, candidateToken }) });
  const key = `${owner}:${trusted.identity.endpoint.id}`;
  await trusted.local.storage.casCandidate(key, null, { version: 1, key, revision: 0, ownerId: owner, candidateId: trusted.identity.endpoint.id, request: link.request, candidateToken, phase: "waiting", state: f.states.get(link.request.requestId)! });
  await trusted.client.refreshInbox();
  expect(f.states.get(link.request.requestId)!.status).toBe("cancelled"); expect(trusted.local.candidates.size).toBe(0);
  expect(trusted.client.snapshot().inbox).toHaveLength(0); expect(trusted.account.snapshot().status).toBe("ready"); expect(f.history().transitions).toHaveLength(0);
});


it("reload resumes MAC publication from the exact durable local confirmation without another click", async () => {
  const f = await comparing(); const record = [...f.candidate.local.candidates.values()][0];
  const confirmedOfferHash = await pendingOfferHash(record.offer!);
  f.candidate.local.candidates.set(record.key, { ...record, confirmedOfferHash }); f.candidate.client.dispose();
  const resumed = new PendingApprovalClient(f.candidate.account, f.fetcher, f.candidate.local.storage); await resumed.ensureCandidate();
  expect(f.states.get(f.id)!.status).toBe("confirmed"); expect(resumed.snapshot().candidate.localConfirmed).toBe(true);
  expect(f.history().transitions).toHaveLength(0); expect(f.candidate.stored()).toBeNull();
});

it("reload publishes its retained unpublished offer without replacing the committed contribution", async () => {
  const f = await fixture(); const candidate = await f.installation(false); const reviewer = await f.installation(true);
  await candidate.client.ensureCandidate(); const id = candidate.client.snapshot().candidate.requestId!; const state = f.states.get(id)!;
  const local = await createPendingOffer(state.request, reviewer.identity, reviewer.signing, f.history());
  const key = `${owner}:${id}`;
  await reviewer.local.storage.casReviewer(key, null, { version: 1, key, revision: 0, ownerId: owner, request: state.request, phase: "active", local, state });
  await reviewer.client.review(id);
  const published = f.commands.find(command => command.payload.action.type === "review")!;
  expect(published.payload.action.type === "review" && published.payload.action.offer).toEqual(local.offer);
  expect([...reviewer.local.reviewers.values()][0].local!.contribution === local.contribution).toBe(true);
});

it("an infrastructure HTML outage preserves the same request and recovers on a valid pending read", async () => {
  const f = await fixture(); const candidate = await f.installation(false); await candidate.client.ensureCandidate();
  const requestId = candidate.client.snapshot().candidate.requestId;
  vi.mocked(f.fetcher).mockResolvedValueOnce(new Response("Temporary upstream outage", { status: 503 }));
  await candidate.client.ensureCandidate();
  expect(candidate.client.snapshot().candidate.status).toBe("waiting"); expect(candidate.client.snapshot().candidate.error).toBe("account_storage_unavailable");
  await candidate.client.ensureCandidate();
  expect(candidate.client.snapshot().candidate.requestId).toBe(requestId); expect(candidate.client.snapshot().candidate.error).toBeNull(); expect(f.states.size).toBe(1);
});

function barrier() {
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  return { waiting, started, release, entered };
}
for (const sibling of [false, true]) it(`local cancellation wins held approved-history verification (${sibling ? "sibling tab" : "same client"})`, async () => {
  const f = await comparing(); await f.candidate.client.confirmCandidate(); await f.reviewer.client.confirmReview();
  const held = barrier();
  const fetcher: typeof fetch = async (input, init) => {
    const result = await f.fetcher(input, init);
    if (String(input) === "/api/security/account") { held.entered(); await held.waiting; }
    return result;
  };
  const completing = new PendingApprovalClient(f.candidate.account, fetcher, f.candidate.local.storage);
  const work = completing.ensureCandidate(); await held.started;
  await (sibling ? f.candidate.client : completing).cancelCandidate();
  held.release(); await work;
  expect(f.candidate.stored()).toBeNull(); expect(f.candidate.account.snapshot().status).toBe("unapproved");
  expect(completing.snapshot().candidate.status).toBe("cancelled");
  expect([...f.candidate.local.candidates.values()][0].phase).toBe("cancelled");
  expect(f.history().transitions).toHaveLength(1); // Remote commit is not local admission.
});
it("completed admission wins cancellation and restart without falsely cancelling or deleting trust", async () => {
  const f = await comparing(); await f.candidate.client.confirmCandidate(); await f.reviewer.client.confirmReview(); await f.candidate.client.ensureCandidate();
  expect([...f.candidate.local.candidates.values()][0].phase).toBe("completed");
  const pin = f.candidate.stored(); const cancels = f.candidateCommands.filter(command => command.action.type === "cancel").length;
  await f.candidate.client.cancelCandidate();
  expect(f.candidate.client.snapshot().candidate.status).toBe("approved"); expect(f.candidate.client.snapshot().candidate.cancellationLost).toBe(true);
  await f.candidate.client.restartCandidate();
  expect(f.candidate.client.snapshot().candidate.status).toBe("approved"); expect(f.candidate.stored()?.checkpoint.head).toBe(pin?.checkpoint.head);
  expect(f.candidateCommands.filter(command => command.action.type === "cancel")).toHaveLength(cancels);
});
it("a stale rendered comparison cannot confirm a sibling tab's replacement request", async () => {
  const f = await comparing(); const rendered = { ...f.candidate.client.snapshot().candidate };
  const sibling = new PendingApprovalClient(f.candidate.account, f.fetcher, f.candidate.local.storage);
  await sibling.cancelCandidate(); await sibling.restartCandidate(); const replacement = sibling.snapshot().candidate.requestId!;
  expect(replacement).not.toBe(rendered.requestId);
  await f.reviewer.client.review(replacement); await sibling.ensureCandidate(); await f.reviewer.client.pollReview(); await sibling.ensureCandidate();
  expect(sibling.snapshot().candidate.status).toBe("comparing");
  await f.candidate.client.confirmCandidate(rendered);
  expect([...f.candidate.local.candidates.values()][0].confirmedOfferHash).toBeUndefined();
  expect(f.candidateCommands.filter(command => command.action.type === "confirm")).toHaveLength(0);
  expect(f.candidate.client.snapshot().candidate.requestId).toBe(replacement);
  await f.candidate.client.confirmCandidate(f.candidate.client.snapshot().candidate);
  expect(f.candidateCommands.filter(command => command.action.type === "confirm")).toHaveLength(1);
});

it("cancellation reloads a CAS loss when another tab commits approval between its read and write", async () => {
  const f = await comparing(); await f.candidate.client.confirmCandidate(); await f.reviewer.client.confirmReview();
  const other = new PendingApprovalClient(f.candidate.account, f.fetcher, f.candidate.local.storage);
  const original = f.candidate.local.storage.casCandidate; let raced = false;
  vi.spyOn(f.candidate.local.storage, "casCandidate").mockImplementation(async (key, revision, value) => {
    if (!raced && value?.phase === "cancelled") { raced = true; await other.ensureCandidate(); return false; }
    return original(key, revision, value);
  });
  await f.candidate.client.cancelCandidate();
  expect(raced).toBe(true); expect(f.candidate.stored()).not.toBeNull();
  expect(f.candidate.client.snapshot().candidate.status).toBe("approved"); expect(f.candidate.client.snapshot().candidate.cancellationLost).toBe(true);
  expect([...f.candidate.local.candidates.values()][0].phase).toBe("completed");
});

it("a fresh sibling cannot call cleaned-up committed approval cancelled during a startup outage", async () => {
  const f = await comparing(); await f.candidate.client.confirmCandidate(); await f.reviewer.client.confirmReview(); await f.candidate.client.ensureCandidate();
  await f.candidate.client.refreshInbox(); expect(f.candidate.local.candidates.size).toBe(0);
  const head = f.candidate.stored()!.checkpoint.head;
  const cancels = f.candidateCommands.filter(command => command.action.type === "cancel").length;
  const implementation = vi.mocked(f.fetcher).getMockImplementation()!;
  vi.mocked(f.fetcher).mockImplementation(async (input, init) => {
    if (String(input) === "/api/security/account") throw new TypeError("offline");
    return implementation(input, init);
  });
  const account = new AccountSecurityClient(owner, f.fetcher, f.candidate.storage);
  const sibling = new PendingApprovalClient(account, f.fetcher, f.candidate.local.storage);
  await sibling.cancelCandidate();
  expect(sibling.snapshot().candidate.status).toBe("completed-unverified");
  expect(sibling.snapshot().candidate.code).toBeNull(); expect(sibling.snapshot().candidate.cancellationLost).toBe(true);
  expect(account.snapshot().status).toBe("error"); expect(account.snapshot().trust).toBeNull();
  expect(f.candidate.stored()!.checkpoint.head).toBe(head);
  expect(f.candidateCommands.filter(command => command.action.type === "cancel")).toHaveLength(cancels);
  await sibling.restartCandidate(); expect(sibling.snapshot().candidate.status).toBe("completed-unverified");
  expect(f.candidate.local.candidates.size).toBe(0);
  vi.mocked(f.fetcher).mockImplementation(implementation);
  await account.refresh(); await sibling.ensureCandidate();
  expect(account.snapshot().status).toBe("ready"); expect(sibling.snapshot().candidate.status).toBe("approved");
  expect(f.states.size).toBe(1);
});
