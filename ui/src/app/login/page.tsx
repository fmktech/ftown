"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useLedger } from "@/hooks/useLedger";
import { accountNameValid, ACCOUNT_NAME_MAX, sanitizeAccountName } from "@/lib/ledger-client";
import { ledgerRuntimeConfig } from "@/lib/ledger-runtime";
import { clearSignedOut, isSignedOut } from "@/lib/signed-out-flag";

/** Resolves against the page origin; only a same-origin path (+ query) is ever returned, never the raw string. */
function safeReturnTo(value: string | null): string | null {
  if (!value || value.length > 512 || value.includes("\\")) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname.startsWith("//")) return null;
    return url.pathname + url.search;
  } catch {
    return null;
  }
}

const CREATION_FAILED = "This account could not be created. Discard this setup and try again.";
const MESSAGES: Record<string, string> = {
  passkey_cancelled: "The passkey prompt was cancelled. Try again when you are ready.",
  secure_context_required: "Passkeys need a secure connection. Open this site over https (or on localhost).",
  passkey_already_registered: "This passkey is already registered. Sign in with it instead.",
  registration_closed: "Account creation is closed on this server.",
  server_full: "This server is not accepting new accounts right now.",
  rate_limited: "Too many attempts. Try again later.",
  invalid_account_name: "Enter an account name of up to 64 characters.",
  creation_too_large: CREATION_FAILED,
  invalid_ledger: CREATION_FAILED,
  handle_taken: CREATION_FAILED,
  ledger_other_account: "This browser already belongs to an account. Sign in with its passkey, or reset this browser in Security first.",
  device_revoked: "This browser was removed from your account.",
  ledger_device_revoked: "This browser was removed from your account.",
  account_not_found: "No account found for that passkey.",
  passkey_unsupported: "This browser does not support passkeys.",
  network_unavailable: "Cannot reach the server. Check your connection.",
  server_unavailable: "The server is not available right now. Try again soon.",
  origin_mismatch: "This page address does not match the server's public address. Open the official address.",
  storage_unavailable: "This browser blocks storage, so it cannot keep your account. Allow site data and try again.",
  sign_in_failed: "Sign in failed. Try again.",
};
function messageFor(code: string): string {
  return Object.prototype.hasOwnProperty.call(MESSAGES, code) ? MESSAGES[code] : "Something went wrong. Try again.";
}

/** Rejections of the creating POST that a retry of the same signed account can outlive (nothing about the account itself is wrong). */
const RETRYABLE = ["registration_closed", "server_full", "rate_limited", "network_unavailable", "server_unavailable"];
/** The signed account can never be accepted as is: only a discard (and a new passkey) gets the user forward. */
const FATAL_CREATION = ["creation_too_large", "invalid_ledger", "origin_mismatch", "handle_taken"];

const inputClass =
  "w-full px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--bg-base)] border border-[var(--border-default)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] outline-none focus-visible:border-[var(--accent)] focus-visible:shadow-[var(--focus-ring)]";

export default function LoginPage() {
  const router = useRouter();
  const { client, snapshot } = useLedger();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState<"signin" | "create" | null>(null);
  const [deviceLabel, setDeviceLabel] = useState("This browser");
  const [passkeyLabel, setPasskeyLabel] = useState("My passkey");
  const [accountName, setAccountName] = useState("");
  const [retryable, setRetryable] = useState(false);
  const tried = useRef(false);

  const done = useCallback(() => {
    const returnTo = safeReturnTo(new URLSearchParams(window.location.search).get("returnTo"));
    router.push(returnTo ?? "/dashboard");
  }, [router]);

  const run = useCallback(async (task: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown_error");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    if (isSignedOut()) return;
    void (async () => {
      try {
        if (await client.signInKnownDevice()) done();
      } catch (err) {
        setError(err instanceof Error ? err.message : "unknown_error");
      }
    })();
  }, [client, done]);

  const revoked = snapshot.status === "device_revoked" || error === "device_revoked" || error === "ledger_device_revoked";
  const [configured, setConfigured] = useState(true);
  useEffect(() => {
    try { setConfigured(ledgerRuntimeConfig().configured); } catch { /* secure/browser checks surface on click */ }
  }, []);
  const startOver = () => run(async () => { await client.forget(); setFlow(null); setRetryable(false); });
  const nameLength = Array.from(sanitizeAccountName(accountName)).length;
  const nameTooLong = nameLength > ACCOUNT_NAME_MAX;
  const nameValid = accountNameValid(accountName);
  const fatal = flow === "create" && error !== null && FATAL_CREATION.includes(error);
  const enrolling = snapshot.pending === "enrollment_ready";

  const identify = () => run(async () => {
    clearSignedOut();
    setFlow("signin");
    const { enrolled } = await client.identifyAccount();
    if (enrolled) done();
  });
  const addBrowser = () => run(async () => {
    clearSignedOut();
    try {
      await client.enrollThisDevice({ deviceLabel });
    } catch (err) {
      if (flow === "create" && err instanceof Error && RETRYABLE.includes(err.message)) setRetryable(true);
      throw err;
    }
    done();
  });
  const retryCreate = () => run(async () => {
    clearSignedOut();
    try {
      await client.retryCreateAccount();
    } catch (err) {
      if (!(err instanceof Error && RETRYABLE.includes(err.message))) setRetryable(false);
      throw err;
    }
    setRetryable(false);
    done();
  });
  const rotate = () => run(async () => { await client.rotateDeviceIdentity(); setError(null); });
  const createStart = () => run(async () => {
    clearSignedOut();
    setFlow("create");
    try {
      await client.createAccountStart({ passkeyLabel, userName: sanitizeAccountName(accountName) });
    } catch (err) {
      // Nothing was started: back to the neutral state so the sign-in button is offered next to the message.
      if (!(err instanceof Error && err.message === "account_creation_pending")) setFlow(null);
      throw err;
    }
  });
  const createFinish = () => run(async () => {
    await client.createAccountFinish();
  });

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm sm:max-w-md rounded-[var(--radius-md)] border border-[var(--border-muted)] bg-[var(--bg-surface)] p-6 sm:p-8">
        <h1 className="text-xl font-bold text-[var(--accent)] mb-2">ftown</h1>
        <p className="text-[var(--text-secondary)] text-sm mb-8 font-[family-name:var(--font-sans)]">Sign in with your passkey</p>

        <Link href="/local" className="btn-ghost block text-center mb-6">This computer — no account needed</Link>

        {error && (
          <div
            id="login-error"
            role="alert"
            aria-live="assertive"
            className="fade-in flex items-start gap-2 px-3 py-2 mb-4 rounded-[var(--radius-sm)] bg-[rgba(255,68,102,0.08)] border border-[var(--status-error)] text-[var(--status-error)] text-sm"
          >
            <span aria-hidden="true">⚠</span>
            <span>{messageFor(error)}</span>
          </div>
        )}

        {revoked ? (
          <div className="space-y-3">
            <p className="text-sm text-[var(--text-secondary)]">
              This browser no longer has access. Reset it, then sign in with your passkey to add it again.
            </p>
            <button type="button" onClick={rotate} disabled={busy} className="btn-accent w-full !py-2.5">Reset this browser</button>
          </div>
        ) : flow !== "create" && enrolling ? (
          <div className="space-y-3">
            <label htmlFor="device-label" className="block text-sm text-[var(--text-secondary)]">Name this browser</label>
            <input id="device-label" value={deviceLabel} onChange={(e) => setDeviceLabel(e.target.value)} className={inputClass} />
            <button type="button" onClick={addBrowser} disabled={busy} className="btn-accent w-full !py-2.5">Add this browser</button>
          </div>
        ) : (
          flow !== "create" && (
            <button type="button" onClick={identify} disabled={busy} className="btn-accent w-full !py-2.5">
              {busy ? "Waiting for passkey..." : "Sign in with passkey"}
            </button>
          )
        )}

        <p className="text-xs text-[var(--text-faint)] mt-4">
          On a shared computer: to stop this browser from signing in at all, remove it in Security. It then needs your passkey again.
        </p>

        <details className="mt-6" open={flow === "create"}>
          <summary className="text-sm text-[var(--text-secondary)] cursor-pointer">Create an account</summary>
          {!configured ? (
            <p className="text-sm text-[var(--status-error)] mt-3" role="alert">
              This server is not configured for account creation (FTOWN public URL missing).
            </p>
          ) : (
          <div className="space-y-3 mt-3">
            <p className="text-sm text-[var(--text-faint)]">Create a new account with a passkey. The passkey is the only key to the account: add a second one right after.</p>
            <div>
              <label htmlFor="account-name" className="block text-sm text-[var(--text-secondary)] mb-1">Account name</label>
              <input
                id="account-name"
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                required
                aria-required="true"
                aria-invalid={nameTooLong}
                aria-describedby={nameTooLong ? "account-name-error" : undefined}
                autoComplete="off"
                className={inputClass}
              />
              {nameTooLong && (
                <p id="account-name-error" role="alert" className="text-xs text-[var(--status-error)] mt-1">
                  Use at most {ACCOUNT_NAME_MAX} characters.
                </p>
              )}
            </div>
            <div>
              <label htmlFor="passkey-label" className="block text-sm text-[var(--text-secondary)] mb-1">Passkey label</label>
              <input id="passkey-label" value={passkeyLabel} onChange={(e) => setPasskeyLabel(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label htmlFor="create-device-label" className="block text-sm text-[var(--text-secondary)] mb-1">This browser label</label>
              <input id="create-device-label" value={deviceLabel} onChange={(e) => setDeviceLabel(e.target.value)} className={inputClass} />
            </div>
            <button type="button" onClick={createStart} disabled={busy || snapshot.pending !== "none" || !nameValid} className="btn-ghost w-full">
              1. Create passkey
            </button>
            <button type="button" onClick={createFinish} disabled={busy || snapshot.pending !== "passkey_created"} className="btn-ghost w-full">
              2. Sign the account
            </button>
            {retryable && flow === "create" ? (
              <button type="button" onClick={retryCreate} disabled={busy} className="btn-ghost w-full">
                3. Retry
              </button>
            ) : (
              <button
                type="button"
                onClick={addBrowser}
                disabled={busy || fatal || flow !== "create" || snapshot.pending !== "enrollment_ready"}
                className="btn-ghost w-full"
              >
                3. Add this browser
              </button>
            )}
            {flow === "create" && snapshot.pending !== "none" && (
              <button type="button" onClick={startOver} disabled={busy} className="btn-ghost w-full">
                Discard this setup and create a new passkey
              </button>
            )}
          </div>
          )}
        </details>
      </div>
    </div>
  );
}
