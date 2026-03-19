"use client";

import { useState, useEffect, useCallback } from "react";
import { useCentrifugo } from "@/hooks/useCentrifugo";
import { SetupForm } from "@/components/SetupForm";
import { Dashboard } from "@/components/Dashboard";

function decodeBase64Url(str: string): string {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return atob(base64);
}

function decodeJwtPayload(token: string): { sub: string; exp?: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(decodeBase64Url(parts[1]));
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return null;
    }
    return payload as { sub: string; exp?: number };
  } catch {
    return null;
  }
}

export default function Home() {
  const [token, setToken] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [centrifugoUrl, setCentrifugoUrl] = useState<string | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    const savedToken = localStorage.getItem("ftown_token");
    const savedUrl = localStorage.getItem("ftown_centrifugoUrl");

    if (savedToken && savedUrl) {
      const payload = decodeJwtPayload(savedToken);
      if (payload?.sub) {
        setToken(savedToken);
        setUserId(payload.sub);
        setCentrifugoUrl(savedUrl);
      } else {
        localStorage.removeItem("ftown_token");
        localStorage.removeItem("ftown_userId");
        localStorage.removeItem("ftown_centrifugoUrl");
      }
    }

    setIsHydrated(true);
  }, []);

  const { client, status, error } = useCentrifugo(token, centrifugoUrl);

  const handleConnect = useCallback((newToken: string, newUserId: string, newUrl: string) => {
    setToken(newToken);
    setUserId(newUserId);
    setCentrifugoUrl(newUrl);
  }, []);

  const handleDisconnect = useCallback(() => {
    localStorage.removeItem("ftown_token");
    localStorage.removeItem("ftown_userId");
    localStorage.removeItem("ftown_centrifugoUrl");
    setToken(null);
    setUserId(null);
    setCentrifugoUrl(null);
  }, []);

  if (!isHydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-[#555] text-sm">Loading...</span>
      </div>
    );
  }

  if (!token || !userId) {
    return <SetupForm onConnect={handleConnect} />;
  }

  return (
    <Dashboard
      client={client}
      connectionStatus={status}
      connectionError={error}
      userId={userId}
      token={token}
      onDisconnect={handleDisconnect}
    />
  );
}
