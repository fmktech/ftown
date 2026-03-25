"use client";

import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { Centrifuge, Subscription } from "centrifuge";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { TokenUsage } from "@/hooks/useSessionEvents";
import "@xterm/xterm/css/xterm.css";

export interface TerminalHandle {
  sendInput: (data: string) => void;
  refit: () => void;
}

interface TerminalProps {
  client: Centrifuge | null;
  sessionId: string | null;
  userId: string | null;
  isRunning: boolean;
  sessionName?: string | null;
  usage?: TokenUsage;
  onMobileTap?: () => void;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal({ client, sessionId, userId, isRunning, sessionName, usage, onMobileTap }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const outputSubRef = useRef<Subscription | null>(null);
  const inputSubRef = useRef<Subscription | null>(null);
  const onMobileTapRef = useRef(onMobileTap);
  const didScrollRef = useRef(false);
  const [scrolledUp, setScrolledUp] = useState(false);

  useImperativeHandle(ref, () => ({
    sendInput(data: string) {
      if (inputSubRef.current) {
        inputSubRef.current.publish({ type: "input", data });
      }
    },
    refit() {
      fitAddonRef.current?.fit();
    },
  }), []);

  useEffect(() => { onMobileTapRef.current = onMobileTap; }, [onMobileTap]);

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

    // Touch scroll: translate vertical swipes into xterm scrollLines
    let touchStartY: number | null = null;
    let accumulatedDelta = 0;
    const LINE_HEIGHT = 20; // approximate px per terminal line

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
      if (lines !== 0) {
        term.scrollLines(lines);
        accumulatedDelta -= lines * LINE_HEIGHT;
      }
    };
    const onTouchEnd = () => {
      touchStartY = null;
      accumulatedDelta = 0;
    };

    const container = containerRef.current;
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      scrollDisposable.dispose();
      resizeObserver.disconnect();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  const prevSessionIdRef = useRef<string | null>(null);

  // Subscribe to centrifugo channels when sessionId changes
  useEffect(() => {
    if (!client || !sessionId || !userId || !xtermRef.current) return;

    const term = xtermRef.current;

    // Only clear terminal when switching to a different session
    if (prevSessionIdRef.current !== sessionId) {
      term.clear();
      term.reset();
      fitAddonRef.current?.fit();
      prevSessionIdRef.current = sessionId;
    }

    // Clean up previous subscriptions
    if (outputSubRef.current) {
      outputSubRef.current.removeAllListeners();
      outputSubRef.current.unsubscribe();
      client.removeSubscription(outputSubRef.current);
      outputSubRef.current = null;
    }
    if (inputSubRef.current) {
      inputSubRef.current.removeAllListeners();
      inputSubRef.current.unsubscribe();
      client.removeSubscription(inputSubRef.current);
      inputSubRef.current = null;
    }

    // Subscribe to terminal output
    const outputChannel = `terminal:${sessionId}#${userId}`;
    const existingOut = client.getSubscription(outputChannel);
    if (existingOut) {
      existingOut.removeAllListeners();
      existingOut.unsubscribe();
      client.removeSubscription(existingOut);
    }

    const outputSub = client.newSubscription(outputChannel, {
      since: { offset: 0, epoch: "" },
    });
    outputSub.on("publication", (ctx) => {
      const msg = ctx.data as { type: string; data?: string };
      if (msg.type === "output" && msg.data) {
        term.write(msg.data);
      }
    });
    outputSub.on("subscribed", () => {
      // History replay is done — send resize to remote PTY to force redraw
      if (inputSubRef.current) {
        inputSubRef.current.publish({ type: "resize", cols: term.cols, rows: term.rows });
      }
    });
    outputSub.subscribe();
    outputSubRef.current = outputSub;

    // Subscribe to terminal input channel
    const inputChannel = `terminal-input:${sessionId}#${userId}`;
    const existingIn = client.getSubscription(inputChannel);
    if (existingIn) {
      existingIn.removeAllListeners();
      existingIn.unsubscribe();
      client.removeSubscription(existingIn);
    }

    const inputSub = client.newSubscription(inputChannel);
    inputSub.subscribe();
    inputSubRef.current = inputSub;

    // Wire xterm input to centrifugo
    const dataDisposable = term.onData((data) => {
      if (inputSubRef.current) {
        inputSubRef.current.publish({ type: "input", data });
      }
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (inputSubRef.current) {
        inputSubRef.current.publish({ type: "resize", cols, rows });
      }
    });

    // Burst resize signals to PTY over 2s to force remote redraw
    const resizeTimers: ReturnType<typeof setTimeout>[] = [];
    // First call: nudge size to force a real resize
    resizeTimers.push(setTimeout(() => {
      term.resize(term.cols, term.rows - 1);
      inputSub.publish({ type: "resize", cols: term.cols, rows: term.rows });
    }, 200));
    // Remaining calls: just send resize at correct size
    for (let i = 1; i < 10; i++) {
      resizeTimers.push(setTimeout(() => {
        fitAddonRef.current?.fit();
        inputSub.publish({ type: "resize", cols: term.cols, rows: term.rows });
      }, 200 * (i + 1)));
    }

    return () => {
      resizeTimers.forEach(clearTimeout);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      if (outputSubRef.current) {
        outputSubRef.current.removeAllListeners();
        outputSubRef.current.unsubscribe();
        client.removeSubscription(outputSubRef.current);
        outputSubRef.current = null;
      }
      if (inputSubRef.current) {
        inputSubRef.current.removeAllListeners();
        inputSubRef.current.unsubscribe();
        client.removeSubscription(inputSubRef.current);
        inputSubRef.current = null;
      }
    };
  }, [client, sessionId, userId]);

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
            <div className="flex items-center gap-2">
              <span style={{ fontSize: 11, color: "var(--text-faint)" }}>›_</span>
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
              {usage && (usage.inputTokens > 0 || usage.outputTokens > 0) && (
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--text-muted)",
                    fontVariantNumeric: "tabular-nums",
                    letterSpacing: "0.04em",
                  }}
                >
                  {formatTokenCount(usage.inputTokens)}in / {formatTokenCount(usage.outputTokens)}out
                </span>
              )}

              {isRunning && (
                <div className="flex items-center gap-2">
                  <span className="status-dot status-dot-running animate-running" />
                  <span style={{ fontSize: 10, color: "var(--accent)", letterSpacing: "0.08em" }}>
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
