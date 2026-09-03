"use client";

import { useCallback } from "react";
import { useAuthMode } from "@/lib/auth-mode";
import { useCentrifugo } from "@/hooks/useCentrifugo";
import { Dashboard } from "@/components/Dashboard";

interface DashboardClientProps {
  userId: string;
  token: string;
  centrifugoUrl: string;
  /** Solo mode: mint hub JWTs via POST /api/solo/token (Bearer key) instead of NextAuth. */
  tokenRefresher?: () => Promise<string>;
  /** Solo mode: handle a permanent auth rejection (default redirects to /login). */
  onUnauthorized?: () => void;
}

export function DashboardClient({
  userId,
  token,
  centrifugoUrl,
  tokenRefresher,
  onUnauthorized,
}: DashboardClientProps) {
  const { signOut } = useAuthMode();

  const { client, status, error, transport } = useCentrifugo(token, centrifugoUrl, userId, {
    tokenRefresher,
    onUnauthorized,
  });

  const handleDisconnect = useCallback(() => {
    signOut();
  }, [signOut]);

  return (
    <Dashboard
      client={client}
      connectionStatus={status}
      connectionError={error}
      userId={userId}
      token={token}
      centrifugoUrl={centrifugoUrl}
      transport={transport}
      onDisconnect={handleDisconnect}
    />
  );
}
