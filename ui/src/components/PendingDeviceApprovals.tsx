"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AccountSecurityClient } from "@/lib/account-security-client";
import type { PendingApprovalClient, PendingSnapshot, PendingView } from "@/lib/pending-approval-client";
import { usePendingApprovals } from "@/hooks/usePendingApprovals";
import { securityErrorMessage } from "./SecurityPanel";

const requestLabels: Record<string, string> = { pending: "Waiting for review", offered: "Waiting for requesting device", submitted: "Opening verification", comparing: "Compare both devices", confirmed: "Ready for trusted confirmation", approved: "Approved — delivery available" };

function Status({ view, candidate }: { view: PendingView; candidate: boolean }) {
  return <div className="space-y-3">
    {view.code && <div className="space-y-2 rounded-lg border border-[var(--accent-dim)] bg-[var(--bg-elevated)] p-4"><p className="text-sm">Compare this code on both actual devices:</p><p aria-label="Verification code" className="break-all font-mono text-2xl tracking-wider">{view.code}</p><p className="text-xs text-[var(--text-muted)]">{candidate ? "Confirm here and on the approved device. A code displayed by the service alone is not approval." : "Ask the person holding the new device to compare and confirm there. Approve only a request you recognize."}</p></div>}
    {view.status === "waiting" || view.status === "idle" ? <p role="status" className="text-sm text-[var(--text-muted)]">{candidate ? "Waiting for an approved device to review this request…" : "Waiting for the requesting device to connect…"}</p> : null}
    {view.status === "confirming" && <p role="status" className="text-sm text-[var(--text-muted)]">{candidate ? "Confirmed here. Waiting for approval on your existing device…" : "Confirmed here. Waiting for confirmation on the requesting device…"}</p>}
    {view.status === "approved" && <p role="status" className="text-sm">{candidate ? "This device is approved. Establishing encrypted connections…" : "Device approved. It can now finish connecting. Keep this view open until it connects; computers may take up to 30 seconds to update."}</p>}
    {candidate && view.status === "approved" && view.cancellationLost && <p role="status" className="text-sm">Approval already completed. To remove access, revoke this device from Security → Access.</p>}
    {candidate && view.status === "completed-unverified" && <p role="status" className="text-sm">Approval was already saved. Reconnect to verify current access. Cancelling cannot undo a completed approval; use Security → Access to revoke access if needed.</p>}
    {view.status === "awaiting-delivery-renewal" && <p role="status" className="text-sm">Your comparison is saved, but delivery expired. Keep or reopen this approval on the trusted device to renew delivery before the five-minute request expires.</p>}
    {view.status === "restart-required" && <p role="status" className="text-sm">Verification is not ready. Another tab may still be opening it. If its temporary state was lost, cancel and start a fresh verification; device keys are preserved.</p>}
    {view.status === "expired" && <p role="status" className="text-sm">This request expired. Start a new request and compare again.</p>}
    {(view.status === "rejected" || view.status === "cancelled") && <p role="status" className="text-sm">This request was {view.status}. Access was not granted by this request.</p>}
    {view.status === "conflict" && <p role="status" className="text-sm">Account devices changed during verification. Cancel this request and start again; the comparison cannot be moved to a different account history.</p>}
    {view.error && <p role="alert" className="break-words text-sm text-[var(--status-error)]">{securityErrorMessage({ code: view.error })}</p>}
  </div>;
}

export function PendingDeviceWaiting({ account, email, incoming = false, onPrivateLink, client: supplied }: { account: AccountSecurityClient; email: string; incoming?: boolean; onPrivateLink: () => void; client?: PendingApprovalClient }) {
  const { client, snapshot } = usePendingApprovals(account, "candidate", supplied); const view = snapshot.candidate;
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const generation = useRef(0);
  useLayoutEffect(() => { generation.current++; setBusy(false); setError(null); return () => { generation.current++; }; }, [account, client]);
  useEffect(() => { if (!view.error) setError(null); }, [view]);
  async function action(run: () => Promise<void>) { const current = ++generation.current; setBusy(true); setError(null); try { await run(); } catch (failure) { if (current === generation.current) setError(securityErrorMessage(failure)); } finally { if (current === generation.current) setBusy(false); } }
  const ended = ["expired", "rejected", "cancelled", "conflict", "restart-required"].includes(view.status);
  const committed = view.status === "approved" || view.status === "completed-unverified";
  return <section aria-labelledby="pending-device-title" className="mx-auto w-full max-w-xl space-y-5 rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] p-5 sm:p-8">
    <h1 id="pending-device-title" className="text-2xl font-semibold">{view.status === "completed-unverified" ? "Approval saved — reconnect to verify" : view.code ? "Compare your devices" : "Waiting for device approval"}</h1>
    <p className="break-words text-sm text-[var(--text-muted)]">Signed in as {email}.</p>
    {incoming && <p role="status" className="text-sm">This browser is not approved and cannot approve another device. This is its own access request. Open the intended approval on an already approved browser.</p>}
    {!committed && <p className="text-sm leading-relaxed">On an approved device, open Security → Access → Pending approvals and choose Review. Compare the code on both devices and confirm locally on each. Sign-in alone does not unlock sessions.</p>}
    <Status view={view} candidate />
    {error && <p role="alert" className="text-sm text-[var(--status-error)]">{error}</p>}
    {view.code && !view.localConfirmed && view.status === "comparing" && <button type="button" className="btn-accent min-h-11 w-full" disabled={busy || !client} onClick={() => { if (client) void action(() => client.confirmCandidate(view)); }}>Codes match on this device</button>}
    {view.code && !ended && view.status !== "approved" && <button type="button" className="btn-ghost min-h-11 w-full" disabled={busy || !client} onClick={() => { if (client) void action(() => client.cancelCandidate()); }}>Codes differ — cancel</button>}
    {ended && <button type="button" className="btn-accent min-h-11 w-full" disabled={busy || !client} onClick={() => { if (client) void action(() => client.restartCandidate()); }}>Start a new request</button>}
    {!view.code && !ended && view.status !== "approved" && <button type="button" className="btn-ghost min-h-11" disabled={busy || !client} onClick={() => { if (client) void action(async () => { if (committed) await account.refresh(); await client.ensureCandidate(); }); }}>Check approval</button>}
    {!view.code && !ended && !committed && <button type="button" className="btn-ghost min-h-11" disabled={busy || !client} onClick={() => { if (client) void action(() => client.cancelCandidate()); }}>Cancel request</button>}
    {!committed && <details className="space-y-3 border-t border-[var(--border-muted)] pt-3"><summary className="min-h-11 cursor-pointer py-3 text-sm">First device or another way to connect?</summary><p className="text-xs leading-relaxed text-[var(--text-muted)]">No approved device yet? Start your first computer with <code>ftown start --bootstrap</code> and open its private pairing link here. The same confirmation enrolls this browser. Local recovery accesses one computer and cannot restore lost account signing keys.</p><button type="button" className="btn-ghost min-h-11" disabled={busy} onClick={() => { void action(async () => { const current = generation.current; if (client) await client.cancelCandidate(); if (current === generation.current) onPrivateLink(); }); }}>Use a private approval link</button></details>}
    <p className="text-xs leading-relaxed text-[var(--text-faint)]">Requests last five minutes. Reload resumes saved verification. Codes must match both actual devices; reject anything unexpected. Lost temporary verification state requires an explicit new attempt. Keep an approved browser available for recovery.</p>
  </section>;
}

export function PendingDeviceInbox({ client, snapshot, offline = false }: { client: PendingApprovalClient; snapshot: PendingSnapshot; offline?: boolean }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [limit, setLimit] = useState(32);
  const generation = useRef(0);
  useLayoutEffect(() => { generation.current++; setBusy(false); setError(null); setLimit(32); return () => { generation.current++; }; }, [client]);
  useEffect(() => { if (!snapshot.inboxError && !snapshot.review?.error) setError(null); }, [snapshot.inbox, snapshot.inboxError, snapshot.review]);
  async function action(run: () => Promise<void>) { const current = generation.current; setBusy(true); setError(null); try { await run(); } catch (failure) { if (current === generation.current) setError(securityErrorMessage(failure)); } finally { if (current === generation.current) setBusy(false); } }
  const requests = snapshot.inbox.filter(item => !["rejected", "cancelled", "expired", "conflict"].includes(item.status)); const review = snapshot.review;
  const authorityError = (code: string | null | undefined) => !!code && ["account_approval_required", "account_device_revoked", "account_offline_expired", "invalid_account_trust", "account_trust_rollback"].includes(code);
  const blocked = offline || authorityError(snapshot.inboxError) || authorityError(review?.error);
  return <section aria-labelledby="pending-inbox-title" className="space-y-4 rounded-lg border border-[var(--border-muted)] p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 id="pending-inbox-title" className="font-semibold">Pending approvals</h3><button type="button" className="btn-ghost min-h-11" disabled={busy} onClick={() => void action(() => client.refreshInbox())}>Refresh requests</button></div>
    <p className="text-xs leading-relaxed text-[var(--text-muted)]">Only review a browser or computer you are adding. Review does not grant access. Both devices must compare and confirm before this browser can sign approval.</p>
    {offline && <p role="status" className="text-sm">Reconnect to verify account trust before reviewing or approving requests.</p>}
    {(error || snapshot.inboxError) && <p role="alert" className="text-sm text-[var(--status-error)]">{error ?? securityErrorMessage({ code: snapshot.inboxError })}</p>}
    {snapshot.inboxLoading && <p role="status" className="text-sm text-[var(--text-muted)]">Checking pending requests…</p>}
    {!requests.length && !snapshot.inboxLoading && !snapshot.inboxError && <p role="status" className="text-sm text-[var(--text-muted)]">No pending requests. Sign in on the new device or start its bridge for this account.</p>}
    <ul aria-label="Pending device approvals" className="space-y-3">{requests.slice(0, limit).map(item => <li key={item.request.requestId} data-pending-request={item.request.requestId} className="space-y-3 rounded-lg border border-[var(--border-muted)] bg-[var(--bg-base)] p-3"><div><h4 className="break-words text-sm font-semibold">{item.request.label || (item.request.kind === "bridge" ? "Computer" : "Browser")}</h4><p className="text-xs text-[var(--text-muted)]">{item.request.kind === "bridge" ? "Computer" : "Browser"} · {requestLabels[item.status] ?? item.status} · expires {new Date(item.request.expiresAt).toLocaleTimeString()}</p></div><div className="flex flex-wrap gap-2"><button type="button" className="btn-accent min-h-11" disabled={busy || blocked} onClick={() => void action(() => client.review(item.request.requestId))}>{item.status === "approved" ? "Open approval" : "Review"}</button>{item.status !== "approved" && <button type="button" className="btn-ghost min-h-11" disabled={busy || blocked} onClick={() => void action(() => client.reject(item.request.requestId))}>Reject</button>}</div></li>)}</ul>
    {requests.length > limit && <button type="button" className="btn-ghost min-h-11" onClick={() => setLimit(value => value + 32)}>Show more requests</button>}
    {review && <section aria-label="Review device approval" className="space-y-4 border-t border-[var(--border-muted)] pt-4"><h4 className="break-words font-semibold">{review.label}</h4><Status view={review} candidate={false} />{review.status === "comparing" && !review.localConfirmed && <button type="button" className="btn-accent min-h-11 w-full" disabled={busy || blocked} onClick={() => void action(() => client.confirmReview(review))}>Codes match — approve device</button>}{!["approved", "rejected", "cancelled", "expired"].includes(review.status) && review.requestId && <button type="button" className="btn-ghost min-h-11" disabled={busy || blocked} onClick={() => void action(() => client.reject(review.requestId!))}>Codes differ — reject request</button>}<button type="button" className="btn-ghost min-h-11" disabled={busy} onClick={() => client.dismissReview()}>Close review</button></section>}
  </section>;
}
