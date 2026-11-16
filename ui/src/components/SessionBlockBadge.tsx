"use client";

import { useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { BlockReason, SessionBlock, ShellType } from "@/types";

const SHELLS: ShellType[] = [
  "claude", "cursor", "codex", "grok", "muse", "antigravity", "opencode", "pi", "kimi-code", "shell",
  "zai", "kimi", "deepseek", "fireworks",
];

const REASONS: Record<BlockReason, string> = {
  usage_limit: "usage limit",
  rate_limit: "rate limit",
  auth: "auth expired",
  crashed: "crashed",
  exited: "exited",
};

export function blockReasonLabel(reason: BlockReason): string {
  return REASONS[reason];
}

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function SessionBlockBadge({ block }: { block: SessionBlock }) {
  const label = blockReasonLabel(block.reason);
  const reset = block.resetAt ? clock(block.resetAt) : "";
  const text = reset ? `${label} · resets ${reset}` : label;
  return (
    <span
      aria-label={`Blocked: ${label}`}
      title={block.resetAt ? `${text} (${block.resetAt})` : text}
      style={{
        flexShrink: 0,
        fontSize: 10,
        lineHeight: 1.3,
        fontWeight: 600,
        letterSpacing: 0.2,
        color: "var(--status-pending)",
        border: "1px solid var(--status-pending)",
        borderRadius: 999,
        padding: "1px 6px",
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

export interface HandoffInput {
  shellType?: string;
  model?: string;
  name?: string;
}

export function HandoffDialog({
  sessionName,
  onClose,
  onSubmit,
}: {
  sessionName: string;
  onClose: () => void;
  onSubmit: (input: HandoffInput) => Promise<void>;
}) {
  const [shell, setShell] = useState("");
  const [model, setModel] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await onSubmit({
        ...(shell ? { shellType: shell } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  };

  return createPortal(
    <div
      role="presentation"
      onMouseDown={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 12 }}
    >
      <form
        role="dialog"
        aria-label="Hand off session"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => { void submit(event); }}
        style={{ width: "min(28rem, calc(100vw - 24px))", maxHeight: "calc(100vh - 24px)", overflow: "auto", background: "var(--bg-elevated, var(--bg-base))", color: "var(--text-primary)", border: "1px solid var(--border-subtle)", borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}
      >
        <div style={{ fontSize: 14, fontWeight: 600 }}>Hand off {sessionName}</div>
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
          Blank harness and model use the next routing pick that still has quota.
        </p>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
          Harness
          <select aria-label="Harness" value={shell} onChange={(event) => setShell(event.target.value)} style={{ minHeight: 36, fontSize: 14 }}>
            <option value="">Next available</option>
            {SHELLS.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
          Model
          <input aria-label="Model" value={model} onChange={(event) => setModel(event.target.value)} placeholder="Next available" style={{ minHeight: 36, fontSize: 14 }} />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
          Name
          <input aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} placeholder={`${sessionName} handoff`} style={{ minHeight: 36, fontSize: 14 }} />
        </label>
        {error && <p role="alert" style={{ margin: 0, color: "var(--status-error)", fontSize: 12 }}>{error}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="button" onClick={onClose} style={{ minHeight: 36 }}>Cancel</button>
          <button type="submit" disabled={pending} style={{ minHeight: 36 }}>{pending ? "Handing off…" : "Hand off"}</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
