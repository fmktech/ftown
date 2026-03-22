"use client";

interface MobileControlBarProps {
  onSendInput: (data: string) => void;
}

const BUTTONS: { label: string; data: string }[] = [
  { label: "ESC", data: "\x1b" },
  { label: "^C", data: "\x03" },
  { label: "S-Tab", data: "\x1b[Z" },
  { label: "\u2191", data: "\x1b[A" },
  { label: "\u2193", data: "\x1b[B" },
  { label: "\u21b5", data: "\r" },
];

export function MobileControlBar({ onSendInput }: MobileControlBarProps) {
  return (
    <div
      className="flex md:hidden shrink-0 items-center justify-around px-2 gap-1"
      style={{
        paddingTop: 4,
        paddingBottom: "max(4px, env(safe-area-inset-bottom))",
        background: "var(--bg-surface)",
        borderTop: "1px solid var(--border-muted)",
      }}
    >
      {BUTTONS.map((btn) => (
        <button
          key={btn.label}
          className="mobile-ctrl-btn"
          style={{
            minWidth: 44,
            minHeight: 44,
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-muted)",
            borderRadius: 6,
            color: "var(--text-secondary)",
            fontSize: 13,
            fontFamily: "var(--font-mono)",
            fontWeight: 600,
            cursor: "pointer",
            touchAction: "manipulation",
            userSelect: "none",
            WebkitUserSelect: "none",
          }}
          onTouchEnd={(e) => {
            e.preventDefault();
            onSendInput(btn.data);
          }}
          onClick={(e) => {
            e.preventDefault();
            onSendInput(btn.data);
          }}
        >
          {btn.label}
        </button>
      ))}
    </div>
  );
}
