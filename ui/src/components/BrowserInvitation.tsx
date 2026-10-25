"use client";

import { useEffect, useRef, useState } from "react";
import { signIn } from "next-auth/react";
import { Centrifuge } from "centrifuge";
import type { BridgeInvitation, BridgeSecurityInfo } from "@security/protocol";
import { captureInvitation, loadBrowserIdentity, parseInvitation, readPinnedBridges } from "@/lib/browser-identity";
import { SecureEndpointRuntime, type SecureTransmit } from "@/lib/secure-endpoint-runtime";
import { securityErrorMessage } from "./SecurityPanel";

interface Account { id: string; email: string }
async function account(): Promise<Account | null> {
  const response = await fetch("/api/auth/session", { credentials: "include", cache: "no-store" });
  if (!response.ok) return null;
  const value: unknown = await response.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value) || !("user" in value)) return null;
  const user = value.user;
  if (!user || typeof user !== "object" || Array.isArray(user) || !("id" in user) || !("email" in user)
    || typeof user.id !== "string" || !user.id.trim() || typeof user.email !== "string" || !user.email.trim()) return null;
  return { id: user.id, email: user.email };
}

export function BrowserInvitation() {
  const raw = useRef<{ value?: unknown; failed?: boolean } | null>(null);
  const [invitation, setInvitation] = useState<BridgeInvitation | null>(null);
  const [user, setUser] = useState<Account | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (!raw.current) {
      try { raw.current = { value: captureInvitation() }; } catch { raw.current = { failed: true }; }
    }
    let active = true;
    if (raw.current.failed) { setError("Open a fresh invitation from the bridge's local CLI or an approved administrator browser."); setChecking(false); }
    else void parseInvitation(raw.current.value).then(async invite => {
      const current = invite.ownerId.startsWith("solo:") ? null : await account();
      if (!active) return;
      setInvitation(invite); setUser(current); setChecking(false);
    }).catch(() => { if (active) { setError("This invitation is invalid or expired. Create a fresh one on the bridge."); setChecking(false); } });
    return () => { active = false; alive.current = false; };
  }, []);

  async function login(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const result = await signIn("credentials", { email, password, redirect: false });
      setPassword("");
      if (result?.error) { setError("Sign-in failed. Check your account details."); return; }
      const current = await account();
      if (!current) throw new Error("unauthorized");
      setUser(current);
    } catch { setError("Sign-in could not be completed. Try again."); }
    finally { if (alive.current) setBusy(false); }
  }

  async function approve() {
    if (!invitation || !invitation.ownerId.startsWith("solo:") && user?.id !== invitation.ownerId) return;
    setBusy(true); setError(null);
    let runtime: SecureEndpointRuntime | null = null;
    let cloud: Centrifuge | null = null;
    try {
      const identity = await loadBrowserIdentity(invitation.ownerId);
      const pins = await readPinnedBridges(invitation.ownerId);
      runtime = new SecureEndpointRuntime(identity, pins);
      const endpointRuntime = runtime;
      let local = false;
      if (invitation.localOrigin) {
        try {
          const response = await fetch(`${invitation.localOrigin}/api/security/info`, { credentials: "omit", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3000) });
          const info = await response.json() as BridgeSecurityInfo;
          local = response.ok && info.bridgeId === invitation.bridgeId && info.endpoint.id === invitation.bridge.id && info.ownerId === invitation.ownerId;
        } catch { /* Discovery failure can choose cloud before enrollment is sent. */ }
      }
      let channel: string;
      let transmit: SecureTransmit;
      if (local && invitation.localOrigin) {
        channel = `local-http:${invitation.bridgeId}`;
        const origin = invitation.localOrigin;
        transmit = async packet => {
          const response = await fetch(`${origin}/api/security/envelope`, { method: "POST", credentials: "omit", cache: "no-store", redirect: "error",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify(packet), signal: AbortSignal.timeout(30_000) });
          if (!response.ok) throw { code: "approval_required" };
          await endpointRuntime.receive(await response.json(), channel);
        };
      } else {
        if (!user) throw { code: "bridge_offline" };
        const response = await fetch("/api/auth/token", { method: "POST", credentials: "include", cache: "no-store" });
        if (!response.ok) throw { code: "approval_required" };
        const bootstrap = await response.json() as { token: string; centrifugoUrl: string };
        // Routing hints in invitations never receive the user's authentication token.
        cloud = new Centrifuge(bootstrap.centrifugoUrl, { token: bootstrap.token });
        const connected = cloud;
        channel = `commands:rpc#${user.email}`;
        const subscription = connected.newSubscription(channel);
        let queue = Promise.resolve();
        subscription.on("publication", context => { queue = queue.then(() => endpointRuntime.receive(context.data, channel)).then(() => {}).catch(() => {}); });
        const ready = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject({ code: "bridge_offline" }), 15_000);
          subscription.on("subscribed", () => { clearTimeout(timer); resolve(); });
          connected.on("disconnected", () => { clearTimeout(timer); reject({ code: "bridge_offline" }); });
        });
        subscription.subscribe(); connected.connect(); await ready;
        transmit = async packet => { await connected.publish(channel, packet); };
      }
      await endpointRuntime.enroll(invitation, label.trim() || "Browser", channel, transmit);
      if (alive.current) {
        raw.current = null; setInvitation(null);
        window.location.replace(invitation.ownerId.startsWith("solo:") ? "/local" : "/dashboard");
      }
    } catch (failure) { if (alive.current) setError(securityErrorMessage(failure)); }
    finally { cloud?.disconnect(); runtime?.dispose(); if (alive.current) setBusy(false); }
  }

  const solo = invitation?.ownerId.startsWith("solo:") ?? false;
  const wrongAccount = !!user && !!invitation && user.id !== invitation.ownerId;
  return <main className="flex min-h-dvh items-center justify-center bg-[var(--bg-base)] p-4">
    <section className="w-full max-w-xl space-y-5 rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] p-5 sm:p-8">
      <h1 className="text-2xl font-semibold">Approve this browser</h1>
      <p className="text-sm leading-relaxed text-[var(--text-muted)]">An invitation establishes encrypted trust with one bridge. Verify the account and bridge fingerprint before granting this browser administrator access.</p>
      {checking && <p role="status">Checking invitation…</p>}
      {error && <p role="alert" className="break-words text-sm text-[var(--status-error)]">{error}</p>}
      {invitation && <dl className="space-y-3 rounded-lg border border-[var(--border-muted)] p-4 text-xs">
        <div><dt className="text-[var(--text-muted)]">Account identity</dt><dd className="break-all font-mono">{invitation.ownerId}</dd></div>
        <div><dt className="text-[var(--text-muted)]">Bridge</dt><dd className="break-all font-mono">{invitation.bridgeId}</dd></div>
        <div><dt className="text-[var(--text-muted)]">Pinned fingerprint</dt><dd className="break-all font-mono">{invitation.bridge.id}</dd></div>
        <div><dt className="text-[var(--text-muted)]">Invitation expires</dt><dd>{new Date(invitation.expiresAt).toLocaleTimeString()}</dd></div>
      </dl>}
      {invitation && !solo && !user && <form onSubmit={event => void login(event)} className="space-y-3">
        <p className="text-sm text-[var(--text-secondary)]">Sign in here to keep the invitation in memory.</p>
        <label className="flex flex-col gap-1 text-sm">Email<input id="invite-email" type="email" required autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} className="min-h-11 rounded border border-[var(--border-muted)] bg-[var(--bg-base)] px-3" /></label>
        <label className="flex flex-col gap-1 text-sm">Password<input id="invite-password" type="password" required autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} className="min-h-11 rounded border border-[var(--border-muted)] bg-[var(--bg-base)] px-3" /></label>
        <button className="btn-accent min-h-11 w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in to approve"}</button>
      </form>}
      {wrongAccount && <p role="alert" className="text-sm text-[var(--status-error)]">Signed in as {user?.email}. This invitation belongs to a different account. Sign out and open a fresh invitation for the intended account.</p>}
      {invitation && (solo || user) && !wrongAccount && <div className="space-y-3">
        {user && <p className="text-sm text-[var(--text-secondary)]">Signed in as {user.email}.</p>}
        <label className="flex flex-col gap-1 text-sm">Name this browser<input maxLength={80} value={label} onChange={event => setLabel(event.target.value)} placeholder="e.g. My phone" className="min-h-11 rounded border border-[var(--border-muted)] bg-[var(--bg-base)] px-3" /></label>
        <p className="text-xs leading-relaxed text-[var(--text-muted)]">Only approve an invitation you requested. This stores a non-extractable private key in this browser. Clearing storage requires fresh approval; keep local CLI access for recovery.</p>
        <button type="button" className="btn-accent min-h-11 w-full" disabled={busy} onClick={() => void approve()}>{busy ? "Establishing encrypted trust…" : "Approve browser and connect"}</button>
      </div>}
      <a href={solo ? "/local" : "/dashboard"} className="inline-flex min-h-11 items-center text-sm text-[var(--text-muted)]">Cancel invitation</a>
    </section>
  </main>;
}
