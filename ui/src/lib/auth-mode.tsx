"use client";

import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { signOut } from "next-auth/react";

import { clearKey, getStoredKey, mintToken } from "@/lib/solo-client";

/**
 * Dual-mode auth context (bridge contract: ui/src/lib/auth-mode.tsx).
 *
 * Hosted builds keep NextAuth behavior exactly where it lives today — this
 * provider only ADDS the solo implementations on top. Solo mode is cookieless
 * (contract S8): sign-out drops the local key and reloads, and hub JWT
 * refreshes go through POST /api/solo/token with the stored Bearer key.
 */

export type AuthModeKind = "hosted" | "solo";

export interface AuthModeValue {
  readonly mode: AuthModeKind;
  /** Ends the session: NextAuth callbackUrl redirect (hosted) or key wipe + reload (solo). */
  signOut: () => void;
  /** Mints a fresh Centrifugo connect credential for the current session. */
  refreshHubToken: () => Promise<string>;
}

const AuthModeContext = createContext<AuthModeValue | null>(null);

function hostedSignOut(): void {
  void signOut({ callbackUrl: "/login" });
}

async function hostedRefreshHubToken(): Promise<string> {
  const response = await fetch("/api/auth/token", {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`Failed to refresh Centrifugo token (status ${response.status})`);
  }
  const data = (await response.json()) as { token: string };
  return data.token;
}

function soloSignOut(): void {
  clearKey();
  window.location.reload();
}

async function soloRefreshHubToken(): Promise<string> {
  const key = getStoredKey();
  if (!key) throw new Error("No ftown access key stored for this device.");
  return (await mintToken(key)).token;
}

export function AuthModeProvider({
  mode,
  children,
}: {
  mode: AuthModeKind;
  children: ReactNode;
}) {
  const value = useMemo<AuthModeValue>(
    () =>
      mode === "solo"
        ? { mode, signOut: soloSignOut, refreshHubToken: soloRefreshHubToken }
        : { mode, signOut: hostedSignOut, refreshHubToken: hostedRefreshHubToken },
    [mode]
  );
  return <AuthModeContext.Provider value={value}>{children}</AuthModeContext.Provider>;
}

/** Current auth mode + session actions. Throws outside an AuthModeProvider. */
export function useAuthMode(): AuthModeValue {
  const ctx = useContext(AuthModeContext);
  if (!ctx) throw new Error("useAuthMode must be used inside <AuthModeProvider>.");
  return ctx;
}

/** Same as useAuthMode but hard-fails unless the app runs in solo mode. */
export function useSoloRequired(): AuthModeValue {
  const ctx = useAuthMode();
  if (ctx.mode !== "solo") throw new Error("This surface requires solo mode.");
  return ctx;
}
