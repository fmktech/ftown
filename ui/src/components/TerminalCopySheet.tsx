"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import { createPortal } from "react-dom";
import { copyText } from "@/lib/copy-text";

export interface TerminalCopySheetProps {
  open: boolean;
  /** Snapshot taken when the sheet was opened; it does not update live. */
  text: string;
  onClose: () => void;
}

const COPIED = "Copied";
const COPY_FAILED = "Copy failed. Long-press the text and choose Copy.";

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  display: "flex",
  flexDirection: "column",
  justifyContent: "flex-end",
  background: "rgba(0, 0, 0, 0.55)",
};

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  maxHeight: "85dvh",
  background: "var(--bg-surface)",
  borderTop: "1px solid var(--border-default)",
  borderRadius: "12px 12px 0 0",
  paddingBottom: "env(safe-area-inset-bottom)",
  color: "var(--text-primary)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "4px 8px 4px 16px",
  borderBottom: "1px solid var(--border-muted)",
  flexShrink: 0,
};

const preStyle: CSSProperties = {
  flex: "1 1 auto",
  minHeight: 120,
  margin: 0,
  padding: 12,
  overflowY: "auto",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.45,
  color: "var(--text-primary)",
  userSelect: "text",
  WebkitUserSelect: "text",
  WebkitTouchCallout: "default",
  touchAction: "pan-y",
  overscrollBehavior: "contain",
};

const footerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 12px",
  borderTop: "1px solid var(--border-muted)",
  flexShrink: 0,
};

const buttonStyle: CSSProperties = {
  minHeight: 44,
  minWidth: 44,
  padding: "0 14px",
  borderRadius: 8,
  border: "1px solid var(--border-default)",
  background: "var(--bg-elevated)",
  color: "var(--text-primary)",
  fontSize: 14,
  fontWeight: 500,
};

export function TerminalCopySheet({ open, text, onClose }: TerminalCopySheetProps): ReactElement | null {
  const preRef = useRef<HTMLPreElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const downOnOverlay = useRef(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const empty = text.length === 0;

  const readSelection = useCallback((): string => {
    const pre = preRef.current;
    const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
    if (!pre || !selection || selection.rangeCount === 0 || selection.isCollapsed) return "";
    const { anchorNode, focusNode } = selection;
    if (!anchorNode || !focusNode || !pre.contains(anchorNode) || !pre.contains(focusNode)) return "";
    return selection.toString();
  }, []);

  // Fresh state on every open/close transition (an existing in-pre selection counts right away).
  useEffect(() => {
    setMessage(null);
    setHasSelection(open && readSelection().length > 0);
  }, [open, readSelection]);

  useEffect(() => {
    if (!open) return;
    const pre = preRef.current;
    if (pre) pre.scrollTop = pre.scrollHeight;
  }, [open, text]);

  // Move focus into the sheet and give it back to the previous element on close/unmount.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!panelRef.current?.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);


  useEffect(() => {
    if (!open) return;
    const onChange = () => setHasSelection(readSelection().length > 0);
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [open, readSelection]);

  if (!open) return null;

  // copyText must start inside the click gesture: nothing is awaited before it.
  const copy = (value: string) => {
    if (!value) return;
    void copyText(value).then(
      (ok) => setMessage(ok ? COPIED : COPY_FAILED),
      () => setMessage(COPY_FAILED),
    );
  };

  // Keep a tap on a button from collapsing the iOS text selection before click fires.
  const keepSelection = (event: React.MouseEvent) => event.preventDefault();

  return createPortal(
    <div
      style={overlayStyle}
      onMouseDown={(event) => { downOnOverlay.current = event.target === event.currentTarget; }}
      onPointerDown={(event) => { downOnOverlay.current = event.target === event.currentTarget; }}
      onClick={(event) => {
        const startedOnOverlay = downOnOverlay.current;
        downOnOverlay.current = false;
        if (startedOnOverlay && event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label="Copy terminal text" style={panelStyle}>
        <div style={headerStyle}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Copy terminal text</h2>
          <button ref={closeRef} type="button" aria-label="Close" onClick={onClose} style={{ ...buttonStyle, border: "none", background: "transparent", color: "var(--text-secondary)" }}>
            ✕
          </button>
        </div>
        <pre ref={preRef} data-testid="terminal-copy-text" style={preStyle}>
          {empty ? "Nothing to copy yet." : text}
        </pre>
        <div style={footerStyle}>
          <button type="button" disabled={empty || !hasSelection} onMouseDown={keepSelection} onClick={() => copy(readSelection())} style={{ ...buttonStyle, opacity: empty || !hasSelection ? 0.4 : 1 }}>
            Copy selection
          </button>
          <button type="button" disabled={empty} onMouseDown={keepSelection} onClick={() => copy(text)} style={{ ...buttonStyle, opacity: empty ? 0.4 : 1, borderColor: "var(--accent)", color: "var(--accent)" }}>
            Copy all
          </button>
          <span role="status" aria-live="polite" style={{ fontSize: 12, color: "var(--text-secondary)", marginLeft: "auto" }}>
            {message}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
