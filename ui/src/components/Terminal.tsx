"use client";

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { TokenUsage } from "@/hooks/useSessionEvents";
import { ShellType, SessionUsage } from "@/types";
import { useTerminal } from "@/hooks/useTerminal";
import { FallbackReason, TerminalTransportApi, TerminalTransportMode } from "@/lib/direct-transport/contract";
import { formatTokens, formatUsage, formatUsageDetail } from "@/lib/format-usage";
import { HarnessIcon } from "./HarnessIcon";
import "@xterm/xterm/css/xterm.css";

export interface TerminalHandle {
  sendInput: (data: string) => void;
  refit: (options?: { forceResize?: boolean }) => void;
}

interface TerminalProps {
  transport: TerminalTransportApi | null;
  sessionId: string | null;
  bridgeId: string | null;
  isRunning: boolean;
  sessionName?: string | null;
  usage?: TokenUsage;
  /** Persisted usage totals from the session record; shown when no live activity usage is present. */
  persistedUsage?: SessionUsage;
  onMobileTap?: () => void;
  shellType?: ShellType;
  /** Fired when a lone ESC (interrupt) keystroke is sent, for optimistic idle. */
  onInterrupt?: () => void;
}

/** A standalone ESC is an interrupt; arrow/function keys are multi-byte CSI/SS3
 *  sequences that merely start with ESC, so only a lone \x1b counts. */
function isLoneInterrupt(data: string): boolean {
  return data === "\x1b";
}

interface TransportModeBadgeConfig {
  label: string;
  title: string;
  color: string;
  glow?: string;
}

const TRANSPORT_MODE_BADGES: Record<TerminalTransportMode, TransportModeBadgeConfig> = {
  direct: {
    label: "P2P",
    title: "Terminal connected directly over WebRTC — data stays on your network.",
    color: "var(--accent)",
    glow: "var(--accent-glow)",
  },
  local: {
    label: "Local",
    title: "Terminal connected over a local socket — data never leaves this machine.",
    color: "var(--accent)",
    glow: "var(--accent-glow)",
  },
  centrifugo: {
    label: "Cloud",
    title: "Terminal relayed through the cloud (Centrifugo).",
    color: "var(--text-muted)",
  },
  connecting: {
    label: "…",
    title: "Negotiating the fastest available terminal connection.",
    color: "var(--text-faint)",
  },
};

/** Cloud-mode tooltip text, varied by why the fallback happened — label stays "Cloud" always. */
const CENTRIFUGO_REASON_TITLES: Record<Exclude<FallbackReason, null>, string> = {
  pairing_failed:
    "P2P unavailable — connection blocked (VPN or firewall may be interfering). Terminal relayed through the cloud.",
  peer_lost: "P2P connection lost — terminal relayed through the cloud.",
};

function TransportModeBadge({
  mode,
  fallbackReason,
}: {
  mode: TerminalTransportMode | null;
  fallbackReason?: FallbackReason;
}) {
  if (!mode) return null;
  const config = TRANSPORT_MODE_BADGES[mode];
  const title =
    mode === "centrifugo" && fallbackReason
      ? CENTRIFUGO_REASON_TITLES[fallbackReason]
      : config.title;

  return (
    <span
      title={title}
      className="flex items-center gap-1 shrink-0"
      style={{
        fontSize: 10,
        lineHeight: 1,
        letterSpacing: "0.04em",
        color: config.color,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-muted)",
        borderRadius: "var(--radius-sm)",
        padding: "3px 6px",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: config.color,
          boxShadow: config.glow ? `0 0 5px ${config.glow}` : undefined,
          flexShrink: 0,
        }}
      />
      {config.label}
    </span>
  );
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal({ transport, sessionId, bridgeId, isRunning, sessionName, usage, persistedUsage, onMobileTap, shellType, onInterrupt }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onMobileTapRef = useRef(onMobileTap);
  const onInterruptRef = useRef(onInterrupt);
  const shellTypeRef = useRef(shellType);
  const sessionIdRef = useRef(sessionId);
  const resizeBounceTimerRef = useRef<number | null>(null);
  const didScrollRef = useRef(false);
  const [scrolledUp, setScrolledUp] = useState(false);
  sessionIdRef.current = sessionId;

  const handleOutput = useCallback((data: string) => {
    xtermRef.current?.write(data);
  }, []);

  // Full screen resync (was the `screen_dump` branch): reset then write,
  // matching prior semantics exactly.
  const handleScreen = useCallback((data: string) => {
    const term = xtermRef.current;
    if (!term) return;
    term.reset();
    if (data) term.write(data);
  }, []);

  const { subscribe, sendInput, sendResize, mode, fallbackReason } = useTerminal(transport, sessionId, bridgeId, handleOutput, handleScreen);
  const sendInputRef = useRef(sendInput);
  sendInputRef.current = sendInput;
  const sendResizeRef = useRef(sendResize);
  sendResizeRef.current = sendResize;

  const publishTerminalResize = (forceResize = false) => {
    const term = xtermRef.current;
    if (!term || !sessionIdRef.current) return;

    if (resizeBounceTimerRef.current !== null) {
      window.clearTimeout(resizeBounceTimerRef.current);
      resizeBounceTimerRef.current = null;
    }

    if (forceResize && term.cols > 2) {
      sendResizeRef.current(term.cols - 1, term.rows);
      resizeBounceTimerRef.current = window.setTimeout(() => {
        resizeBounceTimerRef.current = null;
        if (xtermRef.current === term && sessionIdRef.current) {
          sendResizeRef.current(term.cols, term.rows);
        }
      }, 120);
      return;
    }

    sendResizeRef.current(term.cols, term.rows);
  };

  const fitAndSyncResize = (forceResize = false) => {
    fitAddonRef.current?.fit();
    publishTerminalResize(forceResize);
  };

  useImperativeHandle(ref, () => ({
    sendInput(data: string) {
      sendInputRef.current(data);
      if (isLoneInterrupt(data)) onInterruptRef.current?.();
    },
    refit(options) {
      fitAndSyncResize(options?.forceResize === true);
    },
  }), []);

  useEffect(() => { onMobileTapRef.current = onMobileTap; }, [onMobileTap]);
  useEffect(() => { onInterruptRef.current = onInterrupt; }, [onInterrupt]);
  useEffect(() => { shellTypeRef.current = shellType; }, [shellType]);
  // Initialize xterm once
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      theme: {
        background: "#07070a",
        foreground: "#e8e8f0",
        cursor: "#00ff88",
        cursorAccent: "#07070a",
        selectionBackground: "rgba(0, 255, 136, 0.15)",
        black: "#0a0a0d",
        red: "#ff4466",
        green: "#00ff88",
        yellow: "#ffaa00",
        blue: "#44aaff",
        magenta: "#cc66ff",
        cyan: "#00ddff",
        white: "#c8c8d8",
        brightBlack: "#44444f",
        brightRed: "#ff6680",
        brightGreen: "#33ffaa",
        brightYellow: "#ffcc44",
        brightBlue: "#66bbff",
        brightMagenta: "#dd88ff",
        brightCyan: "#44eeff",
        brightWhite: "#e8e8f0",
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      letterSpacing: 0.3,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 10000,
      allowProposedApi: true,
      // @ts-expect-error padding is a proposed API
      padding: 12,
    });

    const fitAddon = new FitAddon();
    const unicode11Addon = new Unicode11Addon();
    term.loadAddon(fitAddon);
    term.loadAddon(unicode11Addon);
    term.loadAddon(new WebLinksAddon((_event, uri) => {
      window.open(uri, "_blank");
    }));
    term.open(containerRef.current);
    term.unicode.activeVersion = "11";
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Disable mobile keyboard autocorrect/composition to get instant keystrokes
    const xtermTextarea = containerRef.current.querySelector("textarea");
    if (xtermTextarea) {
      xtermTextarea.setAttribute("autocorrect", "off");
      xtermTextarea.setAttribute("autocapitalize", "off");
      xtermTextarea.setAttribute("autocomplete", "off");
      xtermTextarea.setAttribute("spellcheck", "false");

      // On mobile, hide xterm's textarea to prevent IME composition issues.
      // Input is handled by the MobileControlBar's text input instead.
      if ("ontouchstart" in window) {
        xtermTextarea.setAttribute("inputmode", "none");
        xtermTextarea.setAttribute("readonly", "true");
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current);

    // Track whether user has scrolled up from the bottom
    const scrollDisposable = term.onScroll(() => {
      const buffer = term.buffer.active;
      const atBottom = buffer.viewportY >= buffer.baseY;
      setScrolledUp(!atBottom);
    });

    // Touch scroll: translate vertical swipes into PTY line-scroll keybinds
    // for opencode. For other shells, use xterm native scroll.
    let touchStartY: number | null = null;
    let accumulatedDelta = 0;
    const LINE_HEIGHT = 20;

    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0].clientY;
      accumulatedDelta = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (touchStartY === null) return;
      e.preventDefault();
      const currentY = e.touches[0].clientY;
      const delta = touchStartY - currentY;
      touchStartY = currentY;
      accumulatedDelta += delta;

      const lines = Math.trunc(accumulatedDelta / LINE_HEIGHT);
      if (lines === 0) return;
      accumulatedDelta -= lines * LINE_HEIGHT;

      if (shellTypeRef.current === "opencode") {
        const seq = lines < 0 ? "\x1b\x19" : "\x1b\x05";
        sendInputRef.current(seq.repeat(Math.abs(lines)));
      } else {
        term.scrollLines(lines);
      }
    };
    const onTouchEnd = () => {
      touchStartY = null;
      accumulatedDelta = 0;
    };

    // Mouse-wheel: for opencode, translate into PTY line-scroll keybinds.
    // ctrl+alt+y (up) = \x1b\x19, ctrl+alt+e (down) = \x1b\x05
    // Shift+wheel -> half-page (ctrl+alt+u = \x1b\x15 / ctrl+alt+d = \x1b\x04)
    // For other shells, let xterm handle wheel natively.
    const container = containerRef.current;
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd, { passive: true });

    let onWheel: ((e: WheelEvent) => void) | undefined;
    let wheelAccum = 0;
    const WHEEL_LINE_PX = 16;
    let viewport: HTMLElement | null = null;

    if (shellType === "opencode") {
      onWheel = (e: WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();
        wheelAccum += e.deltaY;
        const lines = Math.trunc(wheelAccum / WHEEL_LINE_PX);
        if (lines === 0) return;
        wheelAccum -= lines * WHEEL_LINE_PX;
        const count = Math.abs(lines);
        const seq = e.shiftKey
          ? (lines < 0 ? "\x1b\x15" : "\x1b\x04")
          : (lines < 0 ? "\x1b\x19" : "\x1b\x05");
        sendInputRef.current(seq.repeat(count));
      };

      container.addEventListener("wheel", onWheel, { passive: false, capture: true });
      viewport = container.querySelector(".xterm-viewport") as HTMLElement | null;
      viewport?.addEventListener("wheel", onWheel, { passive: false, capture: true });
    }

    return () => {
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      if (onWheel) {
        container.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
        viewport?.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
      }
      if (resizeBounceTimerRef.current !== null) {
        window.clearTimeout(resizeBounceTimerRef.current);
        resizeBounceTimerRef.current = null;
      }
      scrollDisposable.dispose();
      resizeObserver.disconnect();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  const prevSessionIdRef = useRef<string | null>(null);

  // Subscribe via the terminal transport when sessionId changes
  useEffect(() => {
    if (!transport || !sessionId || !bridgeId || !xtermRef.current) return;

    const term = xtermRef.current;

    // Only clear terminal when switching to a different session
    if (prevSessionIdRef.current !== sessionId) {
      term.clear();
      term.reset();
      fitAddonRef.current?.fit();
      prevSessionIdRef.current = sessionId;
    }

    // subscribe() tears down any previous subscription itself; the transport
    // attaches and delivers a full `screen` resync before incremental output.
    subscribe();
    // A same-size resize is a no-op for tmux, so a switched-in terminal can
    // keep a stale layout. Bounce cols by one and back to force a re-wrap
    // and full redraw at the real window size.
    fitAndSyncResize(true);

    // Wire xterm input to the transport
    const dataDisposable = term.onData((data) => {
      sendInputRef.current(data);
      if (isLoneInterrupt(data)) onInterruptRef.current?.();
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      sendResizeRef.current(cols, rows);
    });

    return () => {
      dataDisposable.dispose();
      resizeDisposable.dispose();
      if (resizeBounceTimerRef.current !== null) {
        window.clearTimeout(resizeBounceTimerRef.current);
        resizeBounceTimerRef.current = null;
      }
    };
  }, [transport, sessionId, bridgeId, subscribe]);

  return (
    <div
      className="flex-1 flex flex-col min-h-0"
      style={{ background: "var(--bg-void)", position: "relative" }}
    >
      {sessionId && (
        <>
          {/* Terminal header */}
          <div
            className="shrink-0 flex items-center justify-between px-4"
            style={{
              height: 36,
              borderBottom: "1px solid var(--border-subtle)",
              background: "var(--bg-surface)",
            }}
          >
            <div className="flex items-center gap-2 min-w-0 overflow-hidden">
              {shellType ? (
                <HarnessIcon harness={shellType} size={14} className="shrink-0" title={shellType} />
              ) : (
                <span style={{ fontSize: 11, color: "var(--text-faint)" }}>›_</span>
              )}
              {sessionName && (
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--text-secondary)",
                    maxWidth: 400,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {sessionName}
                </span>
              )}
            </div>

            <div className="flex items-center gap-3">
              <TransportModeBadge mode={mode} fallbackReason={fallbackReason} />

              {usage && (usage.inputTokens > 0 || usage.outputTokens > 0) ? (
                <span
                  title="Input tokens / Output tokens (live)"
                  style={{
                    fontSize: 10,
                    color: "var(--text-muted)",
                    fontVariantNumeric: "tabular-nums",
                    letterSpacing: "0.04em",
                  }}
                >
                  {formatTokens(usage.inputTokens)} in / {formatTokens(usage.outputTokens)} out
                </span>
              ) : persistedUsage ? (
                <span
                  title={formatUsageDetail(persistedUsage)}
                  style={{
                    fontSize: 10,
                    color: "var(--text-muted)",
                    fontVariantNumeric: "tabular-nums",
                    letterSpacing: "0.04em",
                  }}
                >
                  {formatUsage(persistedUsage)}
                </span>
              ) : null}

              <span className="sr-only" aria-live="polite">
                {isRunning ? "Session running" : ""}
              </span>
              {isRunning && (
                <div className="flex items-center gap-2">
                  <span className="status-dot status-dot-running animate-running" />
                  <span aria-hidden="true" style={{ fontSize: 10, color: "var(--accent)", letterSpacing: "0.08em" }}>
                    running
                  </span>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* xterm container - always in DOM, no display:none */}
      <div
        style={{ position: "relative", flex: 1, minHeight: 0 }}
        onTouchStart={() => { didScrollRef.current = false; }}
        onTouchMove={() => { didScrollRef.current = true; }}
        onClick={() => { if (!didScrollRef.current) onMobileTapRef.current?.(); }}
      >
        <div
          ref={containerRef}
          className="scanlines"
          style={{ position: "absolute", inset: 0, touchAction: "none" }}
        />
        {scrolledUp && (
          <button
            onClick={() => {
              const term = xtermRef.current;
              if (term) {
                term.scrollToBottom();
                setScrolledUp(false);
              }
            }}
            style={{
              position: "absolute",
              bottom: 12,
              right: 12,
              zIndex: 10,
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-muted)",
              color: "var(--text-secondary)",
              fontSize: 18,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
            }}
            aria-label="Scroll to bottom"
            title="Scroll to bottom"
          >
            {"\u2193"}
          </button>
        )}
      </div>

      {!sessionId && (
        <div
          className="flex items-center justify-center"
          style={{ position: "absolute", inset: 0 }}
        >
          <div className="text-center" style={{ animation: "fade-in 0.3s ease-out" }}>
            <div
              style={{
                width: 40,
                height: 40,
                margin: "0 auto 16px",
                border: "1px solid var(--border-muted)",
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-faint)",
                fontSize: 18,
              }}
            >
              ›_
            </div>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 6 }}>
              No session selected
            </p>
            <p style={{ fontSize: 11, color: "var(--text-faint)" }}>
              Pick a session from the sidebar or create a new one
            </p>
          </div>
        </div>
      )}
    </div>
  );
});
