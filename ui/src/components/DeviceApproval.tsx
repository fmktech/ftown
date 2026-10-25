"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { accountComparisonCode, parseAccountEnrollmentLink } from "@security/account-crypto";
import type { AccountEnrollmentLink } from "@security/account-protocol";
import { AccountSecurityClient, type AccountSecuritySnapshot, captureAccountLink, clearAccountLink, deviceApprovalUrl, readAccountSession, safeAccountReturnTo } from "@/lib/account-security-client";
import { useAccountSecurity } from "@/hooks/useAccountSecurity";
import { securityErrorMessage } from "./SecurityPanel";
import { PendingDeviceInbox, PendingDeviceWaiting } from "./PendingDeviceApprovals";
import { usePendingApprovals } from "@/hooks/usePendingApprovals";

type ApprovalError = { message: string; code: string | null; snapshot: AccountSecuritySnapshot | null };
function approvalError(failure: unknown, snapshot: AccountSecuritySnapshot | null = null): ApprovalError {
  const code = failure !== null && typeof failure === "object" && "code" in failure && typeof failure.code === "string" ? failure.code : null;
  return { message: securityErrorMessage(failure), code, snapshot };
}
function terminalError(error: ApprovalError | null): boolean {
  return !!error?.code && ["account_enrollment_invalid", "account_enrollment_expired", "invalid_account_trust", "account_trust_rollback", "account_device_revoked", "account_bridge_revoked"].includes(error.code);
}

export function DeviceApproval({ ownerId, email, client: supplied, incoming = false, onApproved, requestId }: {
  ownerId: string; email: string; client?: AccountSecurityClient; incoming?: boolean; onApproved?: () => void; requestId?: string;
}) {
  const fallback = useAccountSecurity(supplied ? null : ownerId); const client = supplied ?? fallback.client;
  const state = useSyncExternalStore(client?.subscribe ?? (() => () => {}), client?.snapshot ?? (() => fallback.snapshot), () => fallback.snapshot);
  const [privateLink, setPrivateLink] = useState(false);
  const [modeOwner, setModeOwner] = useState<string | null>(null);
  useLayoutEffect(() => {
    let remembered = false; try { remembered = sessionStorage.getItem(`ftown:approval-mode:${ownerId}`) === "private"; } catch { /* Explicit fallback still works without a remembered preference. */ }
    setPrivateLink(remembered); setModeOwner(ownerId);
  }, [ownerId, client]);
  useEffect(() => { if (state.status === "ready") try { sessionStorage.removeItem(`ftown:approval-mode:${ownerId}`); } catch { /* Trust, not a UI preference, controls admission. */ } }, [ownerId, state.status]);
  if (!client || modeOwner !== ownerId || state.status === "checking") return <p role="status">Opening device trust…</p>;
  if (state.status === "error") return <section className="mx-auto max-w-xl space-y-4 p-5"><p role="alert" className="text-sm text-[var(--status-error)]">{securityErrorMessage({ code: state.code })}</p><button type="button" className="btn-ghost min-h-11" onClick={() => { void client.refresh(); }}>Refresh device trust</button></section>;
  if (state.status === "ready" && requestId) return <PendingReviewPage account={client} requestId={requestId} />;
  if (privateLink || incoming && state.status === "ready") return <PrivateDeviceApproval ownerId={ownerId} email={email} client={client} incoming={incoming && state.status === "ready"} onApproved={onApproved} />;
  return <PendingDeviceWaiting key={ownerId} account={client} email={email} incoming={incoming} onPrivateLink={() => { try { sessionStorage.setItem(`ftown:approval-mode:${ownerId}`, "private"); } catch { /* Only a reload preference. */ } setPrivateLink(true); }} />;
}

function PendingReviewPage({ account, requestId }: { account: AccountSecurityClient; requestId: string }) {
  const { client, snapshot } = usePendingApprovals(account, "reviewer");
  useEffect(() => { if (client) void client.review(requestId); }, [client, requestId]);
  return <div className="mx-auto max-w-2xl">{client && <PendingDeviceInbox client={client} snapshot={snapshot} offline={account.snapshot().offline} />}</div>;
}

export function PrivateDeviceApproval({ ownerId, email, client: supplied, incoming = false, onApproved }: {
  ownerId: string; email: string; client?: AccountSecurityClient; incoming?: boolean; onApproved?: () => void;
}) {
  const fallback = useAccountSecurity(supplied ? null : ownerId);
  const client = supplied ?? fallback.client;
  const state = useSyncExternalStore(client?.subscribe ?? (() => () => {}), client?.snapshot ?? (() => fallback.snapshot), () => fallback.snapshot);
  const captured = useRef<{ ownerId: string; encoded: string | null } | null>(null);
  const generation = useRef(0);
  const [link, setLink] = useState<AccountEnrollmentLink | null>(null);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApprovalError | null>(null);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);
  useLayoutEffect(() => {
    generation.current++;
    setLink(null); setCode(""); setError(null); setDone(false); setBusy(false); setCopied(false);
    return () => { generation.current++; };
  }, [ownerId, client, incoming]);
  useLayoutEffect(() => {
    if (!incoming) return;
    const current = generation.current;
    const valid = () => generation.current === current;
    try {
      if (captured.current?.ownerId !== ownerId) captured.current = { ownerId, encoded: captureAccountLink() };
      const encoded = captured.current.encoded;
      if (!encoded) throw { code: "account_enrollment_invalid" };
      void parseAccountEnrollmentLink(encoded).then(async value => {
        if (value.request.kind !== "browser" || value.request.candidate.ownerId !== ownerId) throw { code: "account_enrollment_invalid" };
        const comparison = await accountComparisonCode(value);
        if (valid()) { setLink(value); setCode(comparison); }
      }).catch(failure => { if (valid()) setError(approvalError(failure)); });
    } catch (failure) { if (valid()) setError(approvalError(failure)); }
  // Account refreshes must not reparse the captured request or restart its context.
  }, [incoming, ownerId, client]);
  useEffect(() => {
    if (incoming || !client) return;
    const current = generation.current;
    setBusy(true);
    void client.resumeDevice().then(async value => {
      const comparison = value ? await accountComparisonCode(value) : "";
      if (generation.current === current) { setLink(value); setCode(comparison); setError(null); }
    }).catch(failure => { if (generation.current === current) setError(approvalError(failure, client.snapshot())); })
      .finally(() => { if (generation.current === current) setBusy(false); });
  }, [incoming, client, ownerId]);
  const supersededAuthorityError = error?.code && ["account_approval_required", "invalid_account_trust", "account_trust_rollback"].includes(error.code)
    && error.snapshot && state.status === "ready" && !state.offline && state !== error.snapshot;
  const currentError = supersededAuthorityError ? null : error;
  const terminal = terminalError(currentError);
  useEffect(() => {
    if (incoming || !link || !client || done || terminal) return;
    const current = generation.current;
    let active = true; let running = false;
    const check = async () => {
      if (running) return; running = true;
      try {
        const finished = await client.finishDevice(link);
        if (!active || generation.current !== current) return;
        setError(null);
        if (finished) { setDone(true); onApproved?.(); }
      } catch (failure) { if (active && generation.current === current) setError(approvalError(failure, client.snapshot())); }
      finally { running = false; }
    };
    void check(); const timer = setInterval(() => { void check(); }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [incoming, link, client, done, terminal, onApproved]);
  async function request() {
    if (!client || busy) return;
    const current = generation.current;
    setBusy(true); setError(null); setDone(false); setLink(null); setCode("");
    try {
      const value = await client.requestDevice(label); const comparison = await accountComparisonCode(value);
      if (generation.current === current) { setCode(comparison); setLink(value); setCopied(false); setError(null); }
    } catch (failure) { if (generation.current === current) setError(approvalError(failure, client.snapshot())); }
    finally { if (generation.current === current) setBusy(false); }
  }
  async function approve() {
    if (!client || !link || busy || state.status !== "ready" || state.offline || terminal || currentError?.code === "account_approval_required") return;
    const current = generation.current;
    setBusy(true); setError(null);
    try { await client.approveDevice(link); if (generation.current === current) { clearAccountLink(); setDone(true); } }
    catch (failure) { if (generation.current === current) setError(approvalError(failure, client.snapshot())); }
    finally { if (generation.current === current) setBusy(false); }
  }
  const url = link && !incoming ? deviceApprovalUrl(link) : null;
  return <section aria-labelledby="account-device-approval-title" className="mx-auto w-full max-w-xl space-y-5 rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] p-5 sm:p-8">
    <h1 id="account-device-approval-title" className="text-2xl font-semibold">{incoming ? "Approve a device" : "Approve this device"}</h1>
    <p className="break-words text-sm text-[var(--text-muted)]">Signed in as {email}.</p>
    <p className="text-sm leading-relaxed">{incoming ? "An approved device can control your current and future account computers and approve other devices. Only approve a request you recognize."
      : "Sign-in is complete. Use one of your approved devices to give this browser encrypted access to all current and future account computers."}</p>
    {(state.status === "checking" || busy) && <p role="status" className="text-sm text-[var(--text-muted)]">{busy ? "Saving verified approval…" : "Opening device trust…"}</p>}
    {(currentError || state.status === "error") && <p role="alert" className="break-words text-sm text-[var(--status-error)]">{currentError?.message ?? securityErrorMessage({ code: state.code })}</p>}
    {done ? <div role="status" className="space-y-3 text-sm"><p>{incoming ? "Device approved. It can now finish connecting; computers may take up to 30 seconds to receive the update." : "This device is approved. Establishing encrypted connections…"}</p><a className="btn-accent inline-flex min-h-11 items-center" href="/dashboard">Open dashboard</a></div>
      : incoming ? <>
        {link && <div className="space-y-3 rounded-lg border border-[var(--border-muted)] p-4">
          <h2 className="break-words font-semibold">{link.request.label}</h2>
          <p className="text-xs text-[var(--text-muted)]">Compare this code with the requesting device:</p>
          <p className="break-all font-mono text-xl tracking-wider" aria-label="Comparison code">{code}</p>
          <details className="text-xs"><summary className="min-h-11 cursor-pointer py-3">Device fingerprint</summary><p className="break-all font-mono">{link.request.candidate.id}</p></details>
          <p className="text-xs text-[var(--text-muted)]">Expires {new Date(link.request.expiresAt).toLocaleTimeString()}.</p>
        </div>}
        {state.status === "unapproved" && <p role="status" className="text-sm text-[var(--text-muted)]">This browser is not approved and cannot approve another device. Open this link on an already approved device. To request access for this browser, return to its dashboard.</p>}
        <button type="button" disabled={busy || !link || state.status !== "ready" || state.offline || terminal || currentError?.code === "account_approval_required"} className="btn-accent min-h-11 w-full" onClick={() => void approve()}>Codes match — approve device</button>
        <button type="button" className="btn-ghost min-h-11 w-full" onClick={() => { clearAccountLink(); window.location.assign("/dashboard"); }}>Cancel</button>
      </> : <>
        <label className="flex flex-col gap-2 text-sm">Device name<input value={label} onChange={event => setLabel(event.target.value)} maxLength={200} placeholder="e.g. My phone" className="min-h-11 rounded border border-[var(--border-muted)] bg-[var(--bg-base)] p-3" /></label>
        <button type="button" disabled={busy || !client} className="btn-accent min-h-11 w-full" onClick={() => void request()}>{link ? "Refresh approval request" : "Create approval link"}</button>
        {url && <div role="status" className="space-y-3 rounded-lg border border-[var(--border-muted)] p-4">
          <p className="text-sm">Open this private link on an approved device and compare the code.</p>
          <p className="break-all font-mono text-xl tracking-wider" aria-label="Comparison code">{code}</p>
          <label className="flex flex-col gap-2 text-xs">Private approval link<input readOnly value={url} onFocus={event => event.target.select()} className="min-h-11 w-full min-w-0 rounded border border-[var(--border-muted)] bg-[var(--bg-base)] p-2" /></label>
          <button type="button" className="btn-ghost min-h-11" onClick={() => {
            if (!navigator.clipboard?.writeText) { setError({ message: "Select and copy the private link above.", code: null, snapshot: state }); return; }
            void navigator.clipboard.writeText(url).then(() => setCopied(true)).catch(() => setError({ message: "Select and copy the private link above.", code: null, snapshot: state }));
          }}>{copied ? "Copied" : "Copy approval link"}</button>
          <p className="text-xs text-[var(--text-muted)]">{terminal ? "This request cannot continue. Create a fresh request or return to an approved device." : "Waiting for approval."} Expires {new Date(link!.request.expiresAt).toLocaleTimeString()}. Keep this tab open.</p>
        </div>}
      </>}
    <p className="text-xs leading-relaxed text-[var(--text-muted)]">No approved device available? A local recovery invitation can restore access to one computer, but cannot recover lost account signing keys. Keep an approved device available; resetting established account trust is an explicit recovery operation.</p>
  </section>;
}

/** Anonymous users reach this client capture gate before any login redirect. */
export function DeviceApprovalPage() {
  const capture = useRef(false);
  const [session, setSession] = useState<{ id: string; email: string } | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [returnTo, setReturnTo] = useState("/devices/approve");
  useLayoutEffect(() => {
    let active = true;
    try { if (!capture.current) { capture.current = true; captureAccountLink(); } setReturnTo(safeAccountReturnTo(window.location.pathname + window.location.search) ?? "/devices/approve"); }
    catch (failure) { setError(securityErrorMessage(failure)); }
    void readAccountSession().then(value => { if (active) setSession(value); }).catch(() => { if (active) setError("Sign-in is unavailable. Refresh and try again."); });
    return () => { active = false; };
  }, []);
  return <main className="min-h-dvh p-4 pt-8 sm:p-8">{error ? <p role="alert" className="mx-auto max-w-xl text-sm text-[var(--status-error)]">{error}</p>
    : session === undefined ? <p role="status">Checking account…</p> : session ? <DeviceApproval ownerId={session.id} email={session.email} incoming requestId={new URLSearchParams(window.location.search).get("request") ?? undefined} />
      : <section className="mx-auto max-w-xl space-y-4 rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] p-6"><h1 className="text-xl font-semibold">Sign in to review device access</h1><p className="text-sm">Your approval continuation stays in this tab while you sign in.</p><a className="btn-accent inline-flex min-h-11 items-center" href={`/login?returnTo=${encodeURIComponent(returnTo)}`}>Sign in</a></section>}</main>;
}
