"use client";

import type { FactoryInfo, FactoryListProps } from "./types";

function repoBasename(repoRoot: string): string {
  const parts = repoRoot.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : repoRoot;
}

function initial(factory: FactoryInfo): string {
  return factory.project.slice(0, 1).toUpperCase() || "?";
}

function NewFactoryButton({ onCreateFactory }: { onCreateFactory: () => void }) {
  return (
    <button
      type="button"
      onClick={onCreateFactory}
      aria-label="New factory…"
      title="New factory…"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 22,
        height: 22,
        borderRadius: 5,
        border: "1px solid var(--border-subtle)",
        background: "var(--bg-elevated)",
        color: "var(--text-secondary)",
        cursor: "pointer",
        fontSize: 13,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      ＋
    </button>
  );
}

export function FactoryList({ factories, selectedProject, onSelect, collapsed, onCreateFactory }: FactoryListProps) {
  if (factories.length === 0) {
    if (collapsed) return null;
    return (
      <div
        className="flex flex-col items-center justify-center text-center"
        style={{ color: "var(--text-faint)", fontSize: 11, gap: 8, padding: "32px 16px" }}
      >
        <span aria-hidden style={{ fontSize: 20, color: "var(--text-faint)" }}>
          🏭
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>No factories detected</span>
        <span style={{ color: "var(--text-faint)" }}>
          Deploy one with the /factory skill — loops grouped &quot;Factory: &lt;project&gt;&quot;
          appear here.
        </span>
        {onCreateFactory && (
          <button
            type="button"
            onClick={onCreateFactory}
            className="btn-ghost"
            style={{ marginTop: 4 }}
          >
            New factory…
          </button>
        )}
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="flex flex-col">
        {factories.map((factory) => {
          const selected = factory.project === selectedProject;
          return (
            <button
              key={factory.project}
              onClick={() => onSelect(factory)}
              aria-label={`${factory.project} — ${factory.repoRoot}`}
              aria-current={selected ? "true" : undefined}
              title={`${factory.project}\n${factory.repoRoot}`}
              style={{
                width: "100%",
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                borderBottom: "1px solid var(--border-subtle)",
                borderLeft: `3px solid ${selected ? "var(--accent)" : "var(--border-muted)"}`,
                background: selected ? "var(--bg-elevated)" : "transparent",
                cursor: "pointer",
                padding: "10px 6px",
                fontFamily: "var(--font-mono)",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 22,
                  height: 22,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 5,
                  fontSize: 11,
                  fontWeight: 600,
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border-subtle)",
                  color: selected ? "var(--text-primary)" : "var(--text-secondary)",
                }}
              >
                {initial(factory)}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {onCreateFactory && (
        <div
          className="flex items-center justify-end"
          style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-subtle)" }}
        >
          <NewFactoryButton onCreateFactory={onCreateFactory} />
        </div>
      )}
      {factories.map((factory) => {
        const selected = factory.project === selectedProject;
        return (
          <div
            key={factory.project}
            role="button"
            tabIndex={0}
            aria-current={selected ? "true" : undefined}
            onClick={() => onSelect(factory)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onSelect(factory);
            }}
            style={{
              width: "100%",
              textAlign: "left",
              padding: "9px 12px",
              borderBottom: "1px solid var(--border-subtle)",
              borderLeft: `3px solid ${selected ? "var(--accent)" : "var(--border-muted)"}`,
              background: selected ? "var(--bg-elevated)" : "transparent",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
            }}
            onMouseEnter={(e) => {
              if (!selected) e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              if (!selected) e.currentTarget.style.background = "transparent";
            }}
          >
            <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
              <span aria-hidden style={{ fontSize: 12, flexShrink: 0 }}>
                🏭
              </span>
              <span
                title={factory.project}
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12,
                  fontWeight: 600,
                  color: selected ? "var(--text-primary)" : "var(--text-secondary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {factory.project}
              </span>
              <span
                title={factory.repoRoot}
                style={{
                  fontSize: 10,
                  color: "var(--text-faint)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 120,
                  flexShrink: 0,
                }}
              >
                {repoBasename(factory.repoRoot)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
