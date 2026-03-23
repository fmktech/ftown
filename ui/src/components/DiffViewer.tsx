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
                .diff2html-dark-wrapper .d2h-wrapper {
                  background: transparent;
                }
                .diff2html-dark-wrapper .d2h-file-header {
                  background: #1a1a2e;
                  border-color: #2a2a3e;
                }
                .diff2html-dark-wrapper .d2h-file-name-wrapper {
                  font-family: var(--font-mono);
                }
                .diff2html-dark-wrapper .d2h-code-line-ctn {
                  font-family: var(--font-mono);
                  font-size: 12px;
                }
                .diff2html-dark-wrapper .d2h-code-line {
                  background: #0d0d1a;
                }
                .diff2html-dark-wrapper .d2h-code-side-line {
                  background: #0d0d1a;
                }
                .diff2html-dark-wrapper .d2h-ins .d2h-code-line,
                .diff2html-dark-wrapper .d2h-ins.d2h-code-line {
                  background: rgba(46, 160, 67, 0.15);
                }
                .diff2html-dark-wrapper .d2h-ins .d2h-code-line-ctn,
                .diff2html-dark-wrapper .d2h-ins.d2h-code-line-ctn {
                  background: rgba(46, 160, 67, 0.2);
                }
                .diff2html-dark-wrapper .d2h-del .d2h-code-line,
                .diff2html-dark-wrapper .d2h-del.d2h-code-line {
                  background: rgba(248, 81, 73, 0.15);
                }
                .diff2html-dark-wrapper .d2h-del .d2h-code-line-ctn,
                .diff2html-dark-wrapper .d2h-del.d2h-code-line-ctn {
                  background: rgba(248, 81, 73, 0.2);
                }
                .diff2html-dark-wrapper .d2h-info {
                  background: rgba(56, 189, 248, 0.1);
                  color: rgb(56, 189, 248);
                }
                .diff2html-dark-wrapper .d2h-file-name {
                  color: var(--text-primary);
                }
                .diff2html-dark-wrapper .d2h-code-line-prefix {
                  color: var(--text-faint);
                }
                .diff2html-dark-wrapper .d2h-code-linenumber {
                  background: #12122a;
                  color: var(--text-faint);
                  border-color: #2a2a3e;
                }
                .diff2html-dark-wrapper .d2h-file-list-wrapper {
                  display: none;
                }
                .diff2html-dark-wrapper .d2h-tag {
                  background: #1a1a2e;
                  color: var(--text-muted);
                  border-color: #2a2a3e;
                }
                .diff2html-dark-wrapper .d2h-file-diff {
                  border-color: #2a2a3e;
                }
                .diff2html-dark-wrapper .d2h-diff-table {
                  border-color: #2a2a3e;
                }
                .diff2html-dark-wrapper .d2h-code-line-ctn,
                .diff2html-dark-wrapper .d2h-code-line {
                  color: var(--text-primary);
                }
                .diff2html-dark-wrapper .d2h-info .d2h-code-line-ctn {
                  color: rgb(56, 189, 248);
                }
                .diff2html-dark-wrapper .d2h-file-stats {
                  color: var(--text-muted);
                }
                .diff2html-dark-wrapper .d2h-moved-tag {
                  background: #1a1a2e;
                  color: var(--text-muted);
                }
                .diff2html-dark-wrapper ::-webkit-scrollbar {
                  width: 8px;
                  height: 8px;
                }
                .diff2html-dark-wrapper ::-webkit-scrollbar-track {
                  background: #0d0d1a;
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
