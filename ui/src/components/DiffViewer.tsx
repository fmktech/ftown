"use client";

import { html } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";
import { useCallback, useEffect, useMemo, useState } from "react";

interface DiffViewerProps {
  isOpen: boolean;
  onClose: () => void;
  diff: string;
  diffStat: string;
  sessionName: string;
}

export function DiffViewer({ isOpen, onClose, diff, diffStat, sessionName }: DiffViewerProps) {
  const [copied, setCopied] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

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

  const diffHtml = useMemo(() => {
    if (!diff || !diff.trim()) return "";
    return html(diff, {
      drawFileList: true,
      matching: "lines",
      outputFormat: "line-by-line",
    });
  }, [diff]);

  if (!isOpen) return null;

  const isEmpty = !diff || !diff.trim();

  // The diff HTML is generated from git diff output (trusted internal data),
  // not from user-supplied input, so dangerouslySetInnerHTML is safe here.
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "rgba(0, 0, 0, 0.7)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: visible ? 1 : 0,
        transition: "opacity 0.2s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "92vw",
          maxWidth: 1200,
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-muted)",
          borderRadius: 10,
          overflow: "hidden",
          boxShadow: "0 0 40px rgba(0, 255, 136, 0.06), 0 20px 60px rgba(0, 0, 0, 0.5)",
          transform: visible ? "scale(1)" : "scale(0.97)",
          opacity: visible ? 1 : 0,
          transition: "transform 0.2s ease, opacity 0.2s ease",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 16px",
            height: 40,
            borderBottom: "1px solid var(--border-muted)",
            background: "var(--bg-base)",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--text-primary)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {sessionName}
          </span>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button
              className="btn-ghost"
              onClick={handleCopy}
              style={{
                fontSize: 12,
                padding: "3px 10px",
                fontFamily: "var(--font-mono)",
                minWidth: 62,
              }}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <button
              className="btn-ghost"
              onClick={onClose}
              style={{
                fontSize: 18,
                lineHeight: 1,
                padding: "2px 8px",
                color: "var(--text-muted)",
              }}
            >
              {"\u00D7"}
            </button>
          </div>
        </div>

        {/* Diff stat */}
        {diffStat && (
          <div
            style={{
              padding: "6px 16px",
              borderBottom: "1px solid var(--border-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text-muted)",
              whiteSpace: "pre",
              overflow: "auto",
              flexShrink: 0,
              background: "var(--bg-base)",
            }}
          >
            {diffStat}
          </div>
        )}

        {/* Diff body */}
        <div
          style={{
            flex: 1,
            overflow: "auto",
          }}
        >
          {isEmpty ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--text-muted)",
                fontSize: 13,
                padding: 40,
              }}
            >
              No changes
            </div>
          ) : (
            <div className="diff2html-dark-wrapper">
              <style>{`
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
                  background: #141425 !important;
                  padding: 8px 12px !important;
                }
                .diff2html-dark-wrapper .d2h-file-name-wrapper {
                  font-family: var(--font-mono) !important;
                }
                .diff2html-dark-wrapper .d2h-file-name {
                  color: #e2e8f0 !important;
                  font-weight: 600 !important;
                }
                .diff2html-dark-wrapper .d2h-tag {
                  background: #1e1e35 !important;
                  color: #8892a8 !important;
                }
                .diff2html-dark-wrapper .d2h-file-stats .d2h-lines-added {
                  color: #4ade80 !important;
                }
                .diff2html-dark-wrapper .d2h-file-stats .d2h-lines-deleted {
                  color: #f87171 !important;
                }
                .diff2html-dark-wrapper .d2h-file-diff {
                  background: #0a0a18 !important;
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
                  padding: 0 12px !important;
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
                  width: 48px !important;
                  min-width: 48px !important;
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
                  width: 8px;
                  height: 8px;
                }
                .diff2html-dark-wrapper ::-webkit-scrollbar-track {
                  background: #0a0a18;
                }
                .diff2html-dark-wrapper ::-webkit-scrollbar-thumb {
                  background: #2a2a3e;
                  border-radius: 4px;
                }
                .diff2html-dark-wrapper ::-webkit-scrollbar-thumb:hover {
                  background: #3a3a4e;
                }
              `}</style>
              <div dangerouslySetInnerHTML={{ __html: diffHtml }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
