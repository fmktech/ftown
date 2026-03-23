"use client";

import { html } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";
import { useCallback, useMemo, useState } from "react";

interface DiffViewerProps {
  isOpen: boolean;
  onClose: () => void;
  diff: string;
  diffStat: string;
  sessionName: string;
}

interface FileDiff {
  filename: string;
  content: string;
  additions: number;
  deletions: number;
}

function splitByFile(diff: string): FileDiff[] {
  if (!diff || !diff.trim()) return [];
  const files: FileDiff[] = [];
  const parts = diff.split(/^(?=diff --git )/m);
  for (const part of parts) {
    if (!part.trim()) continue;
    const nameMatch = part.match(/^diff --git a\/(.+?) b\//);
    const filename = nameMatch ? nameMatch[1] : "unknown";
    let additions = 0;
    let deletions = 0;
    for (const line of part.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    files.push({ filename, content: part, additions, deletions });
  }
  return files;
}

function FileDiffSection({ file }: { file: FileDiff }) {
  const [collapsed, setCollapsed] = useState(false);

  const diffHtml = useMemo(() => {
    return html(file.content, {
      drawFileList: false,
      matching: "lines",
      outputFormat: "line-by-line",
    });
  }, [file.content]);

  return (
    <div style={{ borderBottom: "1px solid #1e1e35" }}>
      <button
        onClick={() => setCollapsed(!collapsed)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "6px 12px",
          background: "#141425",
          border: "none",
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          textAlign: "left",
        }}
      >
        <span style={{ color: "#555e70", fontSize: 10, width: 12 }}>
          {collapsed ? "\u25B6" : "\u25BC"}
        </span>
        <span style={{ color: "#e2e8f0", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {file.filename}
        </span>
        <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {file.additions > 0 && <span style={{ color: "#4ade80" }}>+{file.additions}</span>}
          {file.deletions > 0 && <span style={{ color: "#f87171" }}>-{file.deletions}</span>}
        </span>
      </button>
      {!collapsed && (
        <div
          className="diff2html-dark-wrapper"
          dangerouslySetInnerHTML={{ __html: diffHtml }}
        />
      )}
    </div>
  );
}

const DARK_STYLES = `
  .diff2html-dark-wrapper * {
    border-color: #2a2a3e !important;
  }
  .diff2html-dark-wrapper .d2h-wrapper {
    background: transparent !important;
  }
  .diff2html-dark-wrapper .d2h-file-list-wrapper {
    display: none !important;
  }
  .diff2html-dark-wrapper .d2h-file-header {
    display: none !important;
  }
  .diff2html-dark-wrapper .d2h-file-diff {
    background: #0a0a18 !important;
    margin-bottom: 0 !important;
  }
  .diff2html-dark-wrapper .d2h-diff-table {
    font-family: var(--font-mono) !important;
    font-size: 12px !important;
  }
  .diff2html-dark-wrapper .d2h-diff-tbody tr {
    background: #0a0a18 !important;
  }
  .diff2html-dark-wrapper .d2h-code-line,
  .diff2html-dark-wrapper .d2h-code-side-line {
    background: #0a0a18 !important;
    color: #c8cfd8 !important;
    padding: 0 8px !important;
  }
  .diff2html-dark-wrapper .d2h-code-line-ctn {
    background: transparent !important;
    color: inherit !important;
    font-family: var(--font-mono) !important;
    font-size: 12px !important;
  }
  .diff2html-dark-wrapper .d2h-code-line-prefix {
    color: #555e70 !important;
    background: transparent !important;
    user-select: none !important;
  }
  .diff2html-dark-wrapper .d2h-code-linenumber {
    background: #0e0e20 !important;
    color: #3d4555 !important;
    width: 40px !important;
    min-width: 40px !important;
  }
  /* Insertions */
  .diff2html-dark-wrapper .d2h-ins,
  .diff2html-dark-wrapper tr.d2h-ins,
  .diff2html-dark-wrapper .d2h-ins .d2h-code-line,
  .diff2html-dark-wrapper .d2h-ins.d2h-code-line,
  .diff2html-dark-wrapper .d2h-ins .d2h-code-side-line,
  .diff2html-dark-wrapper .d2h-ins.d2h-code-side-line {
    background: rgba(46, 160, 67, 0.12) !important;
    color: #7ee8a0 !important;
  }
  .diff2html-dark-wrapper .d2h-ins .d2h-code-line-ctn,
  .diff2html-dark-wrapper .d2h-ins.d2h-code-line-ctn {
    background: transparent !important;
    color: #7ee8a0 !important;
  }
  .diff2html-dark-wrapper .d2h-ins .d2h-code-line-prefix {
    color: #4ade80 !important;
  }
  .diff2html-dark-wrapper .d2h-ins .d2h-code-linenumber,
  .diff2html-dark-wrapper .d2h-ins.d2h-change .d2h-code-linenumber {
    background: rgba(46, 160, 67, 0.18) !important;
    color: #4ade80 !important;
  }
  /* Deletions */
  .diff2html-dark-wrapper .d2h-del,
  .diff2html-dark-wrapper tr.d2h-del,
  .diff2html-dark-wrapper .d2h-del .d2h-code-line,
  .diff2html-dark-wrapper .d2h-del.d2h-code-line,
  .diff2html-dark-wrapper .d2h-del .d2h-code-side-line,
  .diff2html-dark-wrapper .d2h-del.d2h-code-side-line {
    background: rgba(248, 81, 73, 0.12) !important;
    color: #fca5a5 !important;
  }
  .diff2html-dark-wrapper .d2h-del .d2h-code-line-ctn,
  .diff2html-dark-wrapper .d2h-del.d2h-code-line-ctn {
    background: transparent !important;
    color: #fca5a5 !important;
  }
  .diff2html-dark-wrapper .d2h-del .d2h-code-line-prefix {
    color: #f87171 !important;
  }
  .diff2html-dark-wrapper .d2h-del .d2h-code-linenumber,
  .diff2html-dark-wrapper .d2h-del.d2h-change .d2h-code-linenumber {
    background: rgba(248, 81, 73, 0.18) !important;
    color: #f87171 !important;
  }
  /* Inline change highlights */
  .diff2html-dark-wrapper ins {
    background: rgba(46, 160, 67, 0.35) !important;
    color: #bbf7d0 !important;
    text-decoration: none !important;
  }
  .diff2html-dark-wrapper del {
    background: rgba(248, 81, 73, 0.35) !important;
    color: #fecaca !important;
    text-decoration: none !important;
  }
  /* Hunk info */
  .diff2html-dark-wrapper .d2h-info,
  .diff2html-dark-wrapper .d2h-info .d2h-code-line,
  .diff2html-dark-wrapper .d2h-info .d2h-code-side-line {
    background: rgba(56, 189, 248, 0.08) !important;
    color: #7dd3fc !important;
  }
  .diff2html-dark-wrapper .d2h-info .d2h-code-line-ctn {
    color: #7dd3fc !important;
  }
  .diff2html-dark-wrapper .d2h-info .d2h-code-linenumber {
    background: rgba(56, 189, 248, 0.12) !important;
    color: #7dd3fc !important;
  }
  /* Empty placeholder rows */
  .diff2html-dark-wrapper .d2h-emptyplaceholder,
  .diff2html-dark-wrapper .d2h-code-side-emptyplaceholder {
    background: #0e0e20 !important;
  }
  .diff2html-dark-wrapper .d2h-moved-tag {
    background: #1e1e35 !important;
    color: #8892a8 !important;
  }
  /* Scrollbar */
  .diff2html-dark-wrapper ::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }
  .diff2html-dark-wrapper ::-webkit-scrollbar-track {
    background: #0a0a18;
  }
  .diff2html-dark-wrapper ::-webkit-scrollbar-thumb {
    background: #2a2a3e;
    border-radius: 3px;
  }
  .diff2html-dark-wrapper ::-webkit-scrollbar-thumb:hover {
    background: #3a3a4e;
  }
`;

export function DiffViewer({ isOpen, onClose, diff, diffStat, sessionName }: DiffViewerProps) {
  const [copied, setCopied] = useState(false);

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
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [diff]);

  const files = useMemo(() => splitByFile(diff), [diff]);

  if (!isOpen) return null;

  const isEmpty = !diff || !diff.trim();

  return (
    <aside
      style={{
        width: 480,
        minWidth: 480,
        display: "flex",
        flexDirection: "column",
        borderLeft: "1px solid var(--border-muted)",
        background: "var(--bg-void)",
        overflow: "hidden",
      }}
    >
      <style>{DARK_STYLES}</style>

      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 12px",
          height: 36,
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-surface)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-muted)" }}>
            Changes
          </span>
          <span style={{ fontSize: 10, color: "var(--text-faint)" }}>
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <button
            className="btn-ghost"
            onClick={handleCopy}
            style={{ fontSize: 10, padding: "2px 8px", fontFamily: "var(--font-mono)" }}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
          <button
            className="btn-ghost"
            onClick={onClose}
            style={{ fontSize: 14, lineHeight: 1, padding: "2px 6px", color: "var(--text-faint)" }}
          >
            {"\u00D7"}
          </button>
        </div>
      </div>

      {/* File list */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {isEmpty ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "var(--text-faint)",
              fontSize: 12,
              padding: 40,
            }}
          >
            No changes
          </div>
        ) : (
          files.map((file, i) => <FileDiffSection key={`${file.filename}-${i}`} file={file} />)
        )}
      </div>
    </aside>
  );
}
