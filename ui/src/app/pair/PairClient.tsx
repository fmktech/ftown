"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { accountComparisonCode, parseAccountEnrollmentLink, parseAccountEnrollmentRequest } from "@security/account-crypto";
import type { AccountEnrollmentLink, AccountPairingLookup } from "@security/account-protocol";
import { captureAccountLink, clearAccountLink, readAccountSession, safeAccountReturnTo } from "@/lib/account-security-client";
import { useAccountSecurity } from "@/hooks/useAccountSecurity";
import { DeviceApproval } from "@/components/DeviceApproval";
import { securityErrorMessage } from "@/components/SecurityPanel";

interface PendingDevice extends AccountPairingLookup { bridgeId: string; hostname: string; platform: string; createdAt: string }
function normalize(raw: string): string { const value = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8); return value.length > 4 ? `${value.slice(0, 4)}-${value.slice(4)}` : value; }

export function PairClient({ userEmail, ownerId, onConnected }: { userEmail: string | null; ownerId?: string | null; onConnected?: () => void }) {
  const params = useSearchParams();
  const [session, setSession] = useState<{ id: string; email: string } | null | undefined>(ownerId && userEmail ? { id: ownerId, email: userEmail } : undefined);
  const [userCode, setUserCode] = useState("");
  const [link, setLink] = useState<AccountEnrollmentLink | null>(null);
  const [comparison, setComparison] = useState("");
  const [device, setDevice] = useState<PendingDevice | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "found" | "approved" | "denied">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const captured = useRef<{ encoded: string | null; failed: boolean } | null>(null);
  const { client, snapshot } = useAccountSecurity(session?.id ?? null);
  useLayoutEffect(() => {
    let active = true;
    if (!captured.current) {
      try { captured.current = { encoded: captureAccountLink(), failed: false }; }
      catch { captured.current = { encoded: null, failed: true }; }
    }
    if (captured.current.failed) setError("The private approval link is invalid or expired. Request a fresh link on the computer.");
    else if (captured.current.encoded) void parseAccountEnrollmentLink(captured.current.encoded).then(async value => {
      if (value.request.kind !== "bridge") throw { code: "account_enrollment_invalid" };
      const code = await accountComparisonCode(value);
      if (active) { setLink(value); setComparison(code); }
    }).catch(failure => { if (active) setError(securityErrorMessage(failure)); });
    if (!ownerId || !userEmail) void readAccountSession().then(value => { if (active) setSession(value); }).catch(() => { if (active) setError("Sign-in is unavailable. Refresh and try again."); });
    return () => { active = false; };
  }, [ownerId, userEmail]);
  async function lookup(value: string) {
    const code = normalize(value); setUserCode(code);
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) { setError("Enter the full eight-character computer code."); return; }
    setPhase("loading"); setError(null); setDevice(null);
    try {
      const response = await fetch("/api/auth/bridge/pair/lookup", { method: "POST", credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userCode: code }) });
      if (!response.ok) throw new Error();
      const value = await response.json() as PendingDevice;
      if (typeof value.bridgeId !== "string" || !value.enrollment) { setError("This computer uses the previous pairing flow. Upgrade and restart it to connect with account device approvals."); setPhase("idle"); return; }
      const enrollment = await parseAccountEnrollmentRequest(value.enrollment);
      if (enrollment.kind !== "bridge" || enrollment.bridgeId !== value.bridgeId) throw new Error();
      setDevice({ ...value, enrollment }); setPhase("found");
    } catch { setError("That computer code is invalid, expired, or unavailable. Request a fresh link on the computer."); setPhase("idle"); }
  }
  useEffect(() => {
    const code = params.get("code");
    if (session && code) void lookup(code);
    // The initial public code is read once for each authenticated account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);
  const exactLink = !!link && !!device?.enrollment && JSON.stringify(link.request) === JSON.stringify(device.enrollment);
  async function decide(decision: "approve" | "deny") {
    if (!client || !session || !device || decision === "approve" && (!exactLink || !link)) return;
    setBusy(true); setError(null);
    try {
      const accountApproval = decision === "approve" ? await client.approve(link!, true) : undefined;
      const response = await fetch(`/api/auth/bridge/pair/${decision}`, { method: "POST", credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userCode: normalize(userCode), ...(accountApproval ? { accountApproval } : {}) }) });
      if (!response.ok) throw { code: response.status === 409 ? "account_trust_conflict" : "account_enrollment_invalid" };
      clearAccountLink(); setPhase(decision === "approve" ? "approved" : "denied");
      if (decision === "approve") { if (onConnected) onConnected(); else window.location.assign("/dashboard"); }
    } catch (failure) { setError(securityErrorMessage(failure)); }
    finally { setBusy(false); }
  }
  const returnTo = typeof window !== "undefined" ? safeAccountReturnTo(window.location.pathname + window.location.search) ?? "/pair" : "/pair";
  return <main className="min-h-dvh p-4 pt-8 sm:p-8"><section className="mx-auto w-full max-w-xl space-y-5 rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] p-5 sm:p-8">
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <h1 className="text-2xl font-semibold">Connect a computer</h1>
      {!busy && <a href="/dashboard" className="btn-ghost inline-flex min-h-11 items-center">Back to dashboard</a>}
    </div>
    <p className="text-sm leading-relaxed text-[var(--text-muted)]">One approval connects this computer to your account and establishes encrypted trust. Your approved devices gain access automatically.</p>
    {error && <p role="alert" className="break-words text-sm text-[var(--status-error)]">{error}</p>}
    {session === undefined ? <p role="status">Checking account…</p> : !session ? <><p className="text-sm">Sign in to continue. The private link stays in this tab.</p><a href={`/login?returnTo=${encodeURIComponent(returnTo)}`} className="btn-accent inline-flex min-h-11 items-center">Sign in</a></> : <>
      <p className="break-words text-sm text-[var(--text-muted)]">Signed in as {session.email}.</p>
      {snapshot.status === "unapproved" && snapshot.historyExists && !snapshot.bootstrapRecoverable && client ? <DeviceApproval ownerId={session.id} email={session.email} client={client} /> : <>
        <form onSubmit={event => { event.preventDefault(); void lookup(userCode); }} className="space-y-3">
          <label className="flex flex-col gap-2 text-sm">Computer code<input autoComplete="off" autoCapitalize="characters" value={userCode} onChange={event => setUserCode(normalize(event.target.value))} placeholder="XXXX-XXXX" maxLength={9} className="min-h-11 rounded border border-[var(--border-muted)] bg-[var(--bg-base)] p-3 text-center font-mono tracking-widest" /></label>
          <button disabled={phase === "loading" || busy} className="btn-ghost min-h-11 w-full">{phase === "loading" ? "Looking up…" : "Look up code"}</button>
        </form>
        {device && phase === "found" && <div className="space-y-4 rounded-lg border border-[var(--border-muted)] p-4">
          <h2 className="break-words text-lg font-semibold">{device.hostname || device.bridgeId}</h2><p className="text-xs text-[var(--text-muted)]">{device.platform} · {device.bridgeId}</p>
          {exactLink ? <><p className="text-sm">Compare this code with the computer:</p><p aria-label="Comparison code" className="break-all font-mono text-xl tracking-wider">{comparison}</p>
            <p className="text-xs leading-relaxed text-[var(--text-muted)]">{snapshot.historyExists ? "Only approve a computer you recognize." : "This also approves this browser as your first account device. It can control your account computers and approve other devices."}</p></>
            : <p role="alert" className="text-sm text-[var(--status-error)]">Open the full private pairing link from this computer. The public code alone cannot establish encryption trust.</p>}
          {snapshot.status === "error" && <p role="alert" className="text-sm text-[var(--status-error)]">{securityErrorMessage({ code: snapshot.code })}</p>}
          <div className="flex flex-wrap gap-3"><button disabled={busy || !exactLink || snapshot.status === "checking" || snapshot.status === "error" || snapshot.offline} onClick={() => void decide("approve")} className="btn-accent min-h-11">{busy ? "Connecting securely…" : "Codes match — connect computer"}</button>
            <button disabled={busy} onClick={() => void decide("deny")} className="btn-ghost min-h-11">Deny</button></div>
        </div>}
      </>}
    </>}
    {phase === "approved" && <p role="status">Computer approved. Opening the dashboard while it establishes its encrypted connection…</p>}
    {phase === "denied" && <p role="status">Computer denied. No access was granted.</p>}
  </section></main>;
}
