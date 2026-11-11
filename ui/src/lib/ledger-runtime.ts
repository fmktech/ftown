import { signIn } from "next-auth/react";
import { clearDeviceAuthKey, loadDeviceAuthKey } from "./device-auth-key";
import { deleteBrowserIdentity, loadBrowserIdentity } from "./browser-identity";
import { LedgerClient, type LedgerClientDeps } from "./ledger-client";
import { LedgerPeers } from "./ledger-peers";
import { LedgerReplica, indexedDbReplicaStorage } from "./ledger-replica";
import * as passkey from "./passkey";

export interface LedgerRuntimeConfig {
  origin: string;
  /** The configured public origin, or null when NEXT_PUBLIC_FTOWN_PUBLIC_URL is unset or not a canonical origin. */
  publicOrigin: string | null;
  rpId: string;
  /** True only when the public origin is configured (or, in development, defaulted to the page origin). */
  configured: boolean;
}

function requireBrowser(): void {
  if (typeof window === "undefined") throw new Error("ledger_client_browser_only");
}
function canonical(value: string | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  try { return new URL(text).origin === text ? text : null; } catch { return null; }
}

/** Page-level ledger configuration. Browser only. */
export function ledgerRuntimeConfig(): LedgerRuntimeConfig {
  requireBrowser();
  const origin = window.location.origin;
  let publicOrigin = canonical(process.env.NEXT_PUBLIC_FTOWN_PUBLIC_URL);
  // Development only: an unset public URL falls back to the page origin so local dev and e2e can create accounts.
  // In production an unset value stays unconfigured and account creation is refused.
  if (publicOrigin === null && process.env.NODE_ENV !== "production" && !process.env.NEXT_PUBLIC_FTOWN_PUBLIC_URL?.trim()) publicOrigin = origin;
  const rpId = process.env.NEXT_PUBLIC_FTOWN_RP_ID?.trim() || new URL(publicOrigin ?? origin).hostname;
  return { origin, publicOrigin, rpId, configured: publicOrigin !== null };
}

/** The real dependency set (exported for tests). */
export function buildLedgerDeps(): LedgerClientDeps {
  const config = ledgerRuntimeConfig();
  return {
    origin: config.origin,
    pageOrigin: window.location.origin,
    // '' never equals the page origin, so the client refuses account creation until the public origin is configured.
    publicOrigin: config.configured && config.publicOrigin !== null ? config.publicOrigin : "",
    rpId: config.rpId,
    replica: new LedgerReplica(indexedDbReplicaStorage()),
    passkey,
    deviceKey: loadDeviceAuthKey,
    endpoint: accountId => loadBrowserIdentity(accountId),
    resetDeviceIdentity: async accountId => {
      await clearDeviceAuthKey();
      await deleteBrowserIdentity(accountId);
    },
    signIn: async proofJson => {
      const result = await signIn("ledger", { proof: proofJson, redirect: false });
      return !!result && !result.error && result.ok !== false;
    },
    attemptStorage: window.sessionStorage,
  };
}

let instance: LedgerClient | null = null;
let peers: LedgerPeers | null = null;

/**
 * The single LedgerClient of this page. Browser only; safe to import during SSR, throws if called on the server. Its beforeSign hook is
 * the agreement step with the account's other online replicas (LedgerPeers), created with it; that step does nothing until the signed-in
 * dashboard's relay connection attaches to it (useCentrifugo).
 */
export function getLedgerClient(): LedgerClient {
  requireBrowser();
  if (instance === null) {
    const deps = buildLedgerDeps();
    let agreement: LedgerPeers | null = null;
    const client = new LedgerClient({ ...deps, beforeSign: head => (agreement === null ? Promise.resolve() : agreement.prepare(head)) });
    agreement = new LedgerPeers({ client, heads: () => deps.replica.heads(), trusted: () => deps.replica.trusted(), deviceKey: deps.deviceKey });
    instance = client;
    peers = agreement;
  }
  return instance;
}

/** The agreement step of the page's LedgerClient when `client` is that client (created by getLedgerClient), else null. */
export function ledgerPeersFor(client: unknown): LedgerPeers | null {
  return instance !== null && client === instance ? peers : null;
}

/** Test seam: disposes and drops the singletons. */
export function resetLedgerClientForTests(): void {
  peers?.dispose();
  instance?.dispose();
  instance = null;
  peers = null;
}
