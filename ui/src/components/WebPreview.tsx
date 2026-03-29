"use client";

import { useState, useCallback, useRef, useEffect, KeyboardEvent } from "react";

interface WebPreviewProps {
  isOpen: boolean;
  onClose: () => void;
  externalUrl?: string | null;
}

export function WebPreview({ isOpen, onClose, externalUrl }: WebPreviewProps) {
  const [url, setUrl] = useState("http://localhost:3000");
  const [iframeSrc, setIframeSrc] = useState("http://localhost:3000");

  useEffect(() => {
    if (externalUrl) {
      setUrl(externalUrl);
      setIframeSrc(externalUrl);
    }
  }, [externalUrl]);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const navigate = useCallback(() => {
    let target = url.trim();
    if (!target) return;
    if (!/^https?:\/\//i.test(target)) {
      target = "http://" + target;
      setUrl(target);
    }
    setIframeSrc(target);
  }, [url]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") navigate();
    },
    [navigate]
  );

  const handleRefresh = useCallback(() => {
    if (iframeRef.current) {
      iframeRef.current.src = iframeSrc;
    }
  }, [iframeSrc]);

  if (!isOpen) return null;

  return (
    <aside
      className="hidden md:flex"
      style={{
        width: "50vw",
        minWidth: 400,
        flexDirection: "column",
        borderLeft: "1px solid var(--border-muted)",
        background: "var(--bg-void)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 8px",
          height: 36,
          borderBottom: "1px solid var(--border-subtle)",
          background: "var(--bg-surface)",
          flexShrink: 0,
        }}
      >
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          style={{
            flex: 1,
            height: 24,
            padding: "0 8px",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--text-primary)",
            background: "var(--bg-void)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 3,
            outline: "none",
          }}
        />
        <button
          className="btn-ghost"
          onClick={navigate}
          style={{ fontSize: 11, padding: "2px 8px", minHeight: 24 }}
        >
          Go
        </button>
        <button
          className="btn-ghost"
          onClick={handleRefresh}
          style={{ fontSize: 13, padding: "2px 6px", minHeight: 24, lineHeight: 1 }}
        >
          ↻
        </button>
        <button
          className="btn-ghost"
          onClick={onClose}
          style={{ fontSize: 16, padding: "2px 6px", minHeight: 24, lineHeight: 1 }}
        >
          ×
        </button>
      </div>

      <iframe
        ref={iframeRef}
        src={iframeSrc}
        style={{
          flex: 1,
          width: "100%",
          border: "none",
          background: "#fff",
        }}
      />
    </aside>
  );
}
