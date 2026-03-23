"use client";

import { useCallback } from "react";

interface DiffViewerProps {
  isOpen: boolean;
  onClose: () => void;
  diff: string;
  diffStat: string;
  sessionName: string;
}

function classifyLine(line: string): string {
  if (line.startsWith("diff --git")) return "diff-file-header";
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-meta";
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return "diff-ctx";
}

export function DiffViewer({ isOpen, onClose, diff, diffStat, sessionName }: DiffViewerProps) {
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(diff);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = diff;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  }, [diff]);

  if (!isOpen) return null;

  const lines = diff.split("\n");

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "80vw",
          maxWidth: 900,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-muted)",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 16px",
            borderBottom: "1px solid var(--border-subtle)",
            background: "var(--bg-base)",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
            Diff — {sessionName}
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="btn-ghost" onClick={handleCopy}>
              Copy
            </button>
            <button
              className="btn-ghost"
              onClick={onClose}
              style={{ fontSize: 16, lineHeight: 1, padding: "2px 6px" }}
            >
              &times;
            </button>
          </div>
        </div>

        {/* Diff stat summary */}
        {diffStat && (
          <div
            style={{
              padding: "8px 16px",
              borderBottom: "1px solid var(--border-subtle)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--text-muted)",
              whiteSpace: "pre",
              flexShrink: 0,
            }}
          >
            {diffStat}
          </div>
        )}

        {/* Diff content */}
        <div
          style={{
            flex: 1,
            overflow: "auto",
            padding: "12px 16px",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: "pre",
          }}
        >
          {lines.map((line, i) => {
            const cls = classifyLine(line);
            let style: React.CSSProperties = { color: "var(--text-secondary)" };

            if (cls === "diff-add") {
              style = { color: "rgb(34, 197, 94)", background: "rgba(34, 197, 94, 0.1)" };
            } else if (cls === "diff-del") {
              style = { color: "rgb(239, 68, 68)", background: "rgba(239, 68, 68, 0.1)" };
            } else if (cls === "diff-hunk") {
              style = { color: "rgb(56, 189, 248)" };
            } else if (cls === "diff-file-header") {
              style = { color: "var(--text-primary)", fontWeight: 700 };
            }

            return (
              <div key={i} style={{ ...style, paddingRight: 16 }}>
                {line}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
