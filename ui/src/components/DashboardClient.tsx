"use client";

import { useCallback } from "react";
import { signOut } from "next-auth/react";
import { useCentrifugo } from "@/hooks/useCentrifugo";
import { Dashboard } from "@/components/Dashboard";

interface DashboardClientProps {
  userId: string;
  token: string;
  centrifugoUrl: string;
}

export function DashboardClient({ userId, token, centrifugoUrl }: DashboardClientProps) {
  const { client, status, error } = useCentrifugo(token, centrifugoUrl);

  const handleDisconnect = useCallback(() => {
    signOut({ callbackUrl: "/login" });
  }, []);

  return (
    <Dashboard
      client={client}
      connectionStatus={status}
      connectionError={error}
      userId={userId}
      token={token}
      centrifugoUrl={centrifugoUrl}
      onDisconnect={handleDisconnect}
    />
  );
}
