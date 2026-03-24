"use client";

import { useRef, useCallback, forwardRef, useImperativeHandle } from "react";

export interface MobileControlBarHandle {
  focusInput: () => void;
}

interface MobileControlBarProps {
  onSendInput: (data: string) => void;
}

const BUTTONS: { label: string; data: string }[] = [
  { label: "ESC", data: "\x1b" },
  { label: "^C", data: "\x03" },
  { label: "Tab", data: "\t" },
  { label: "\u2191", data: "\x1b[A" },
  { label: "\u2193", data: "\x1b[B" },
  { label: "\u21B5", data: "\r" },
];

export const MobileControlBar = forwardRef<MobileControlBarHandle, MobileControlBarProps>(
  function MobileControlBar({ onSendInput }, ref) {
    const inputRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => ({
      focusInput() {
        inputRef.current?.focus();
      },
    }), []);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
      const input = e.currentTarget;

      if (e.key === "Enter") {
        e.preventDefault();
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
        return;
      }
    }, [onSendInput]);

    const handleInput = useCallback((e: React.FormEvent<HTMLInputElement>) => {
      const input = e.currentTarget;
      const value = input.value;
      if (!value) return;
      onSendInput(value);
      input.value = "";
    }, [onSendInput]);

    const focusInput = useCallback(() => {
      inputRef.current?.focus();
    }, []);

    return (
      <div
        className="touch-control-bar shrink-0 flex-col"
        style={{
          paddingBottom: "max(4px, env(safe-area-inset-bottom))",
          background: "var(--bg-surface)",
          borderTop: "1px solid var(--border-muted)",
        }}
      >
        {/* Hidden input — offscreen but still focusable for keyboard */}
        <input
          ref={inputRef}
          type="text"
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="send"
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          style={{
            position: "absolute",
            left: -9999,
            opacity: 0,
            width: 0,
            height: 0,
          }}
        />

        {/* Control buttons row */}
        <div className="flex items-center justify-around px-2 gap-1" style={{ paddingTop: 4, paddingBottom: 2 }}>
          {/* Keyboard toggle button */}
          <button
            className="mobile-ctrl-btn"
            style={{
              minWidth: 44,
              minHeight: 40,
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--accent)",
              border: "1px solid var(--accent)",
              borderRadius: 6,
              color: "var(--bg-void)",
              fontSize: 16,
              fontWeight: 700,
              cursor: "pointer",
              touchAction: "manipulation",
              userSelect: "none",
              WebkitUserSelect: "none",
            }}
            onTouchEnd={(e) => { e.preventDefault(); focusInput(); }}
            onClick={(e) => { e.preventDefault(); focusInput(); }}
          >
            {"\u2328"}
          </button>
          {BUTTONS.map((btn) => (
            <button
              key={btn.label}
              className="mobile-ctrl-btn"
              style={{
                minWidth: 44,
                minHeight: 40,
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
);
