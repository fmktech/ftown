"use client";

import { useEffect, useState } from "react";
import type { ConnectionStatus } from "@/hooks/useCentrifugo";
import { ConnectionDiagnostics } from "./ConnectionDiagnostics";

interface Props {
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  centrifugoUrl: string;
  token: string;
  onRetry: () => void;
}

/** Cloud availability must never cover or unmount working local terminals. */
export function CloudConnectionNotice(props: Props) {
  const [details, setDetails] = useState(false);
  useEffect(() => {
    if (props.connectionStatus === "connected") setDetails(false);
  }, [props.connectionStatus]);

  if (props.connectionStatus === "connected") return null;

  return (
    <>
      <div style={{ position: "absolute", top: 8, right: 8, zIndex: 90, maxWidth: "min(420px, calc(100% - 16px))", padding: "8px 12px", borderRadius: 8, background: "var(--bg-surface)", border: "1px solid var(--border-muted)", fontSize: 12 }}>
        <div role="status">Cloud disconnected — reconnecting automatically. Local/P2P terminals remain available when reachable. Cloud controls resume after reconnecting.</div>
        <button className="btn-ghost" onClick={() => setDetails(true)}>Connection details</button>
      </div>
      {details && (
        <ConnectionDiagnostics {...props} onDismiss={() => setDetails(false)} />
      )}
    </>
  );
}
