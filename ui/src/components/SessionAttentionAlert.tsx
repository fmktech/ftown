import type { VisibleSessionAttention } from "@/lib/session-attention";

interface SessionAttentionAlertProps {
  attention: VisibleSessionAttention;
  isDesktop: boolean;
  onOpen: (sessionId: string) => void;
  onDismiss: (sessionId: string) => void;
}

export function SessionAttentionAlert({
  attention,
  isDesktop,
  onOpen,
  onDismiss,
}: SessionAttentionAlertProps) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        position: "fixed",
        right: 16,
        bottom: isDesktop
          ? "max(16px, env(safe-area-inset-bottom))"
          : "calc(max(16px, env(safe-area-inset-bottom)) + 94px)",
        zIndex: 100,
        width: "min(360px, calc(100vw - 32px))",
        padding: 14,
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--status-pending)",
        background: "var(--bg-overlay)",
        boxShadow: "var(--shadow-lg)",
      }}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden style={{ color: "var(--status-pending)", fontWeight: 800 }}>!</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 700 }}>
            {attention.title}
          </div>
          <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-muted)" }}>
            {attention.sessionName}: {attention.message}
          </div>
          <button
            type="button"
            className="btn-warn"
            style={{ marginTop: 10 }}
            onClick={() => {
              onDismiss(attention.sessionId);
              onOpen(attention.sessionId);
            }}
          >
            Open session
          </button>
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          title="Dismiss"
          onClick={() => onDismiss(attention.sessionId)}
          style={{
            minWidth: 44,
            minHeight: 44,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-faint)",
            fontSize: 18,
            lineHeight: 1,
            cursor: "pointer",
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
