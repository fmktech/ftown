"use client";

import { useEffect, useRef, useState } from "react";
import { parsePairLink } from "@security/ledger/pairing";
import { useLedger } from "@/hooks/useLedger";

export const PAIR_LINK_STORAGE_KEY = "ftown-pair-link";
const MAX_WRONG_CODES = 5;

function readStored(): string | null {
  try { return window.sessionStorage.getItem(PAIR_LINK_STORAGE_KEY); } catch { return null; }
}
function writeStored(fragment: string): boolean {
  try { window.sessionStorage.setItem(PAIR_LINK_STORAGE_KEY, fragment); return true; } catch { return false; }
}
function clearStored(): void {
  try { window.sessionStorage.removeItem(PAIR_LINK_STORAGE_KEY); } catch { /* nothing stored */ }
}
function clearFragment(): void {
  try { window.history.replaceState(null, "", window.location.pathname); } catch { /* ignore */ }
}

export function pairErrorMessage(code: string): string {
  switch (code) {
    case "pair_code_mismatch": return "That code does not match the one on your computer.";
    case "pair_attempts_exceeded": return "Too many wrong codes. This link was discarded. Request a new link on the computer.";
    case "pair_link_expired":
    case "invalid_pair_link": return "This link is invalid or expired. Request a new link on the computer.";
    case "account_bridge_revoked": return "This computer was removed from your account and cannot be added again with this link.";
    case "pair_bridge_conflict": return "This computer is already paired with different keys. Request a new link on the computer.";
    case "passkey_cancelled": return "The passkey prompt was cancelled. Try again.";
    case "secure_context_required": return "Open this page over HTTPS to approve with a passkey.";
    case "signed_out":
    case "unauthorized": return "Your session ended. Sign in again.";
    case "pair_mailbox_conflict": return "This link was already approved.";
    default: return "Could not approve this computer. Try again.";
  }
}

type Phase = "checking" | "redirecting" | "ready" | "discarded" | "done";

export function PairClient({ signedIn }: { signedIn: boolean }) {
  const { client, snapshot } = useLedger();
  const [phase, setPhase] = useState<Phase>("checking");
  const [label, setLabel] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const [picking, setPicking] = useState(false);
  const fragment = useRef<string | null>(null);
  const wrong = useRef(0);

  useEffect(() => {
    const load = (): void => {
    const hash = window.location.hash;
    const raw = hash.length > 1 ? hash : readStored();
    if (raw === null) { setError("Open the private link shown on your computer."); setPhase("discarded"); return; }
    let stored = false;
    try {
      const link = parsePairLink(raw);
      fragment.current = raw;
      stored = writeStored(raw);
      clearFragment();
      setLabel(link.request.label);
      setExpiresAt(link.request.expiresAt);
      if (Date.now() >= link.request.expiresAt) setExpired(true);
    } catch {
      clearStored(); clearFragment();
      setError(pairErrorMessage("invalid_pair_link")); setPhase("discarded");
      return;
    }
    if (!signedIn) {
      if (!stored) {
        setError("Your browser blocks storage, so the link cannot be kept while you sign in. Sign in first, then open the link again.");
        setPhase("discarded");
        return;
      }
      setPhase("redirecting");
      window.location.replace("/login?returnTo=" + encodeURIComponent("/pair"));
      return;
    }
    setPhase("ready");
    };
    load();
    const onHashChange = (): void => {
      if (window.location.hash.length <= 1) return;
      wrong.current = 0;
      setError(null); setCode(""); setExpired(false); setPicking(false); setBusy(false);
      load();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [signedIn]);

  useEffect(() => {
    if (expiresAt === null || phase !== "ready") return;
    const timer = window.setInterval(() => { if (Date.now() >= expiresAt) setExpired(true); }, 30000);
    return () => window.clearInterval(timer);
  }, [expiresAt, phase]);

  const signer = snapshot.signer;
  const authorityCount = snapshot.checkpoint?.authorities.length ?? 0;
  const needsPick = signer === null && authorityCount > 1;

  async function choosePasskey() {
    if (busy) return;
    setBusy(true); setError(null);
    try { await client.selectPasskey(); setPicking(true); }
    catch (failure) { setError(pairErrorMessage(failure instanceof Error ? failure.message : "")); }
    finally { setBusy(false); }
  }

  function discard(message: string) {
    fragment.current = null; clearStored(); clearFragment();
    setCode(""); setError(message); setPhase("discarded");
  }

  async function approve() {
    const current = fragment.current;
    if (current === null || busy) return;
    setBusy(true); setError(null);
    try {
      await client.approveBridge(current, code);
      fragment.current = null; clearStored(); clearFragment();
      setPhase("done");
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "";
      if (message === "pair_code_mismatch") {
        wrong.current += 1;
        if (wrong.current >= MAX_WRONG_CODES) discard(pairErrorMessage("pair_attempts_exceeded"));
        else setError(pairErrorMessage(message));
      } else if (message === "pair_attempts_exceeded" || message === "invalid_pair_link" || message === "pair_link_expired") {
        discard(pairErrorMessage(message));
      } else {
        setError(pairErrorMessage(message));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-dvh p-4 pt-8 sm:p-8">
      <section className="mx-auto w-full max-w-xl space-y-5 rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] p-5 sm:p-8">
        <h1 className="text-2xl font-semibold">Connect a computer</h1>
        {error && <p role="alert" className="break-words text-sm text-[var(--status-error)]">{error}</p>}
        {(phase === "checking" || phase === "redirecting") && <p role="status">{phase === "redirecting" ? "Redirecting to sign in…" : "Checking link…"}</p>}
        {phase === "ready" && expired && <p role="alert" className="text-sm">This pairing link has expired. Run <code>ftown start</code> on the computer to get a new one.</p>}
        {phase === "ready" && !expired && (
          <form className="space-y-4" onSubmit={event => { event.preventDefault(); void approve(); }}>
            <p className="break-words text-sm">Add <strong>{label}</strong> to your account.</p>
            <p className="text-sm leading-relaxed text-[var(--text-muted)]">Type the 6-digit code shown in the terminal of that computer. Approve only if you started this pairing yourself.</p>
            <label className="block text-sm">
              <span className="mb-1 block">Code from your computer</span>
              <input
                value={code}
                onChange={event => setCode(event.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                inputMode="numeric" autoComplete="off" maxLength={6}
                className="min-h-11 w-full rounded border border-[var(--border-muted)] bg-transparent px-3 font-mono tracking-widest"
              />
            </label>
            {needsPick && !picking && (
              <button type="button" onClick={() => void choosePasskey()} disabled={busy} className="btn-ghost inline-flex min-h-11 items-center">Choose passkey</button>
            )}
            <button type="submit" disabled={busy || code.length !== 6 || (needsPick && !picking)} className="btn-accent inline-flex min-h-11 items-center">
              {busy ? "Waiting for passkey…" : "Approve with passkey"}
            </button>
          </form>
        )}
        {phase === "done" && (
          <>
            <p role="status" className="text-sm">Computer added</p>
            <a href="/dashboard" className="btn-ghost inline-flex min-h-11 items-center">Back to dashboard</a>
          </>
        )}
        {phase === "discarded" && <a href="/dashboard" className="btn-ghost inline-flex min-h-11 items-center">Back to dashboard</a>}
      </section>
    </main>
  );
}
