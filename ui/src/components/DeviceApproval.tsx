"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { accountComparisonCode, parseAccountEnrollmentLink } from "@security/account-crypto";
import type { AccountEnrollmentLink } from "@security/account-protocol";
import { AccountSecurityClient, captureAccountLink, clearAccountLink, deviceApprovalUrl, readAccountSession } from "@/lib/account-security-client";
import { useAccountSecurity } from "@/hooks/useAccountSecurity";
import { securityErrorMessage } from "./SecurityPanel";

export function DeviceApproval({ ownerId, email, client: supplied, incoming = false, onApproved }: {
  ownerId: string; email: string; client?: AccountSecurityClient; incoming?: boolean; onApproved?: () => void;
}) {
  const fallback = useAccountSecurity(supplied ? null : ownerId);
  const client = supplied ?? fallback.client;
  const state = useSyncExternalStore(client?.subscribe ?? (() => () => {}), client?.snapshot ?? (() => fallback.snapshot), () => fallback.snapshot);
  const captured = useRef<{ encoded: string | null } | null>(null);
  const [link, setLink] = useState<AccountEnrollmentLink | null>(null);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);
  useLayoutEffect(() => {
    if (!incoming) return;
    let active = true;
    try {
      if (!captured.current) captured.current = { encoded: captureAccountLink() };
      const encoded = captured.current.encoded;
      if (!encoded) { setError("Open the approval link from the device you want to add."); return; }
      void parseAccountEnrollmentLink(encoded).then(async value => {
        if (value.request.kind !== "browser" || value.request.candidate.ownerId !== ownerId) throw { code: "account_enrollment_invalid" };
        const comparison = await accountComparisonCode(value);
        if (active) { setLink(value); setCode(comparison); }
      }).catch(failure => { if (active) setError(securityErrorMessage(failure)); });
    } catch (failure) { setError(securityErrorMessage(failure)); }
    return () => { active = false; };
  }, [incoming, ownerId]);
  useEffect(() => {
    if (incoming || !link || !client || done) return;
    let active = true; let running = false;
    const check = async () => {
      if (running) return; running = true;
      try {
        if (await client.finishDevice(link) && active) { setDone(true); setError(null); onApproved?.(); }
      } catch (failure) { if (active) setError(securityErrorMessage(failure)); }
      finally { running = false; }
    };
    void check(); const timer = setInterval(() => { void check(); }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [incoming, link, client, done, onApproved]);
  async function request() {
    if (!client) return; setBusy(true); setError(null);
    try { const value = await client.requestDevice(label); setCode(await accountComparisonCode(value)); setLink(value); setCopied(false); }
    catch (failure) { setError(securityErrorMessage(failure)); }
    finally { setBusy(false); }
  }
  async function approve() {
    if (!client || !link) return; setBusy(true); setError(null);
    try { await client.approveDevice(link); clearAccountLink(); setDone(true); }
    catch (failure) { setError(securityErrorMessage(failure)); }
    finally { setBusy(false); }
  }
  const url = link && !incoming ? deviceApprovalUrl(link) : null;
  return <section aria-labelledby="account-device-approval-title" className="mx-auto w-full max-w-xl space-y-5 rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] p-5 sm:p-8">
    <h1 id="account-device-approval-title" className="text-2xl font-semibold">{incoming ? "Approve a device" : "Approve this device"}</h1>
    <p className="break-words text-sm text-[var(--text-muted)]">Signed in as {email}.</p>
    <p className="text-sm leading-relaxed">{incoming ? "An approved device can control your current and future account computers and approve other devices. Only approve a request you recognize."
      : "Sign-in is complete. Use one of your approved devices to give this browser encrypted access to all current and future account computers."}</p>
    {(state.status === "checking" || busy) && <p role="status" className="text-sm text-[var(--text-muted)]">{busy ? "Saving verified approval…" : "Opening device trust…"}</p>}
    {(error || state.status === "error") && <p role="alert" className="break-words text-sm text-[var(--status-error)]">{error ?? securityErrorMessage({ code: state.code })}</p>}
    {done ? <div role="status" className="space-y-3 text-sm"><p>{incoming ? "Device approved. It can now finish connecting; computers may take up to 30 seconds to receive the update." : "This device is approved. Establishing encrypted connections…"}</p><a className="btn-accent inline-flex min-h-11 items-center" href="/dashboard">Open dashboard</a></div>
      : incoming ? <>
        {link && <div className="space-y-3 rounded-lg border border-[var(--border-muted)] p-4">
          <h2 className="break-words font-semibold">{link.request.label}</h2>
          <p className="text-xs text-[var(--text-muted)]">Compare this code with the requesting device:</p>
          <p className="break-all font-mono text-xl tracking-wider" aria-label="Comparison code">{code}</p>
          <details className="text-xs"><summary className="min-h-11 cursor-pointer py-3">Device fingerprint</summary><p className="break-all font-mono">{link.request.candidate.id}</p></details>
          <p className="text-xs text-[var(--text-muted)]">Expires {new Date(link.request.expiresAt).toLocaleTimeString()}.</p>
        </div>}
        {state.status === "unapproved" && <p role="status" className="text-sm text-[var(--text-muted)]">Open this link on a device already approved for this account. This browser cannot approve another device yet.</p>}
        <button type="button" disabled={busy || !link || state.status !== "ready" || state.offline} className="btn-accent min-h-11 w-full" onClick={() => void approve()}>Codes match — approve device</button>
        <button type="button" className="btn-ghost min-h-11 w-full" onClick={() => { clearAccountLink(); window.location.assign("/dashboard"); }}>Cancel</button>
      </> : <>
        <label className="flex flex-col gap-2 text-sm">Device name<input value={label} onChange={event => setLabel(event.target.value)} maxLength={200} placeholder="e.g. My phone" className="min-h-11 rounded border border-[var(--border-muted)] bg-[var(--bg-base)] p-3" /></label>
        <button type="button" disabled={busy || !client} className="btn-accent min-h-11 w-full" onClick={() => void request()}>{link ? "Refresh approval request" : "Create approval link"}</button>
        {url && <div role="status" className="space-y-3 rounded-lg border border-[var(--border-muted)] p-4">
          <p className="text-sm">Open this private link on an approved device and compare the code.</p>
          <p className="break-all font-mono text-xl tracking-wider" aria-label="Comparison code">{code}</p>
          <label className="flex flex-col gap-2 text-xs">Private approval link<input readOnly value={url} onFocus={event => event.target.select()} className="min-h-11 w-full min-w-0 rounded border border-[var(--border-muted)] bg-[var(--bg-base)] p-2" /></label>
          <button type="button" className="btn-ghost min-h-11" onClick={() => {
            if (!navigator.clipboard?.writeText) { setError("Select and copy the private link above."); return; }
            void navigator.clipboard.writeText(url).then(() => setCopied(true)).catch(() => setError("Select and copy the private link above."));
          }}>{copied ? "Copied" : "Copy approval link"}</button>
          <p className="text-xs text-[var(--text-muted)]">Waiting for approval. Expires {new Date(link!.request.expiresAt).toLocaleTimeString()}. Keep this tab open.</p>
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
  useLayoutEffect(() => {
    let active = true;
    try { if (!capture.current) { capture.current = true; captureAccountLink(); } }
    catch (failure) { setError(securityErrorMessage(failure)); }
    void readAccountSession().then(value => { if (active) setSession(value); }).catch(() => { if (active) setError("Sign-in is unavailable. Refresh and try again."); });
    return () => { active = false; };
  }, []);
  return <main className="min-h-dvh p-4 pt-8 sm:p-8">{error ? <p role="alert" className="mx-auto max-w-xl text-sm text-[var(--status-error)]">{error}</p>
    : session === undefined ? <p role="status">Checking account…</p> : session ? <DeviceApproval ownerId={session.id} email={session.email} incoming />
      : <section className="mx-auto max-w-xl space-y-4 rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] p-6"><h1 className="text-xl font-semibold">Sign in to approve a device</h1><p className="text-sm">Your private link stays in this tab while you sign in.</p><a className="btn-accent inline-flex min-h-11 items-center" href="/login?returnTo=%2Fdevices%2Fapprove">Sign in</a></section>}</main>;
}
