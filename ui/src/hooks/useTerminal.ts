"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { TerminalTransportApi, TerminalTransportMode } from "@/lib/direct-transport/contract";

interface UseTerminalResult {
  subscribe: () => void;
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  /** Current data-path for this session; null until subscribed. Exposed for
   *  future UI badges — no visual consumer yet. */
  mode: TerminalTransportMode | null;
}

/**
 * Consumes ONLY TerminalTransportApi (see ui/src/lib/direct-transport/contract.ts).
 * The transport (HybridTerminalTransport) owns the direct/Centrifugo path
 * choice and resync-on-switch behavior; this hook just wires it to xterm
 * callbacks. `onScreen` must fully replace terminal contents (clear/reset
 * then write), matching the previous screen_dump handling.
 */
export function useTerminal(
  transport: TerminalTransportApi | null,
  sessionId: string | null,
  bridgeId: string | null,
  onOutput: (data: string) => void,
  onScreen: (data: string) => void
): UseTerminalResult {
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const onOutputRef = useRef(onOutput);
  onOutputRef.current = onOutput;
  const onScreenRef = useRef(onScreen);
  onScreenRef.current = onScreen;
  const [mode, setMode] = useState<TerminalTransportMode | null>(null);

  const cleanup = useCallback(() => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
  }, []);

  const subscribe = useCallback(() => {
    cleanup();
    if (!transport || !sessionId || !bridgeId) {
      setMode(null);
      return;
    }

    unsubscribeRef.current = transport.subscribeTerminal(sessionId, bridgeId, {
      onOutput: (data) => onOutputRef.current(data),
      onScreen: (data) => onScreenRef.current(data),
    });
    setMode(transport.getMode(sessionId));
  }, [transport, sessionId, bridgeId, cleanup]);

  // Track mode transitions (e.g. direct <-> centrifugo fallback) for this session.
  useEffect(() => {
    if (!transport || !sessionId) return undefined;
    return transport.onModeChange((changedSessionId, newMode) => {
      if (changedSessionId === sessionId) setMode(newMode);
    });
  }, [transport, sessionId]);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  const sendInput = useCallback(
    (data: string) => {
      if (!transport || !sessionId) return;
      transport.sendInput(sessionId, data);
    },
    [transport, sessionId]
  );

  const sendResize = useCallback(
    (cols: number, rows: number) => {
      if (!transport || !sessionId) return;
      transport.sendResize(sessionId, cols, rows);
    },
    [transport, sessionId]
  );

  return { subscribe, sendInput, sendResize, mode };
}
