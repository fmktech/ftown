"use client";

import { useRef, useCallback } from "react";

interface MobileControlBarProps {
  onSendInput: (data: string) => void;
}

const BUTTONS: { label: string; data: string }[] = [
  { label: "ESC", data: "\x1b" },
  { label: "^C", data: "\x03" },
  { label: "Tab", data: "\t" },
  { label: "\u2191", data: "\x1b[A" },
  { label: "\u2193", data: "\x1b[B" },
];

export function MobileControlBar({ onSendInput }: MobileControlBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    const input = e.currentTarget;

    if (e.key === "Enter") {
      e.preventDefault();
      // Send whatever text is in the input + newline
      if (input.value) {
        onSendInput(input.value);
        input.value = "";
      }
      onSendInput("\r");
      return;
    }

    if (e.key === "Backspace") {
      if (!input.value) {
        e.preventDefault();
        onSendInput("\x7f");
      }
      // If there's text in input, let the browser handle backspace normally
      return;
    }
  }, [onSendInput]);

  const handleInput = useCallback((e: React.FormEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const value = input.value;

    if (!value) return;

    // Send all characters and clear
    onSendInput(value);
    input.value = "";
  }, [onSendInput]);

  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      className="flex md:hidden shrink-0 flex-col"
      style={{
        paddingBottom: "max(4px, env(safe-area-inset-bottom))",
        background: "var(--bg-surface)",
        borderTop: "1px solid var(--border-muted)",
      }}
    >
      {/* Text input row */}
      <div className="flex items-center px-2 gap-1" style={{ paddingTop: 4, paddingBottom: 4 }}>
        <input
          ref={inputRef}
          type="text"
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="send"
          placeholder="Type here..."
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          style={{
            flex: 1,
            height: 40,
            background: "var(--bg-void)",
            border: "1px solid var(--border-muted)",
            borderRadius: 6,
            color: "var(--text-primary)",
            fontSize: 14,
            fontFamily: "var(--font-mono)",
            padding: "0 10px",
            outline: "none",
            caretColor: "var(--accent)",
          }}
        />
        <button
          className="mobile-ctrl-btn"
          style={{
            minWidth: 44,
            height: 40,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--accent)",
            border: "none",
            borderRadius: 6,
            color: "var(--bg-void)",
            fontSize: 16,
            fontWeight: 700,
            cursor: "pointer",
            touchAction: "manipulation",
          }}
          onTouchEnd={(e) => { e.preventDefault(); const input = inputRef.current; if (input?.value) { onSendInput(input.value); input.value = ""; } onSendInput("\r"); }}
          onClick={(e) => { e.preventDefault(); const input = inputRef.current; if (input?.value) { onSendInput(input.value); input.value = ""; } onSendInput("\r"); }}
        >
          {"\u21B5"}
        </button>
      </div>

      {/* Control buttons row */}
      <div className="flex items-center justify-around px-2 gap-1" style={{ paddingBottom: 2 }}>
        {BUTTONS.map((btn) => (
          <button
            key={btn.label}
            className="mobile-ctrl-btn"
            style={{
              minWidth: 44,
              minHeight: 36,
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-muted)",
              borderRadius: 6,
              color: "var(--text-secondary)",
              fontSize: 12,
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
              focusInput();
            }}
            onClick={(e) => {
              e.preventDefault();
              onSendInput(btn.data);
              focusInput();
            }}
          >
            {btn.label}
          </button>
        ))}
      </div>
    </div>
  );
}
