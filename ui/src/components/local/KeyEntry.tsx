"use client";

import { useEffect, useState, type FormEvent } from "react";

/**
 * First-run key entry for ftown Solo. Accepts either the raw 64-hex access
 * key or the whole `…/#k=<hex>` link printed by `ftown-bridge --solo`.
 * Mobile-first: 16px input (no iOS focus zoom), thumb-height CTA, inline
 * validation error with a shake on rejection (disabled under
 * prefers-reduced-motion).
 */

interface KeyEntryProps {
  /** Called with the normalized key once it passes client-side format checks. */
  onSubmit: (key: string) => void;
  submitting: boolean;
  /** Server-side rejection message (401 from /api/solo/bootstrap), if any. */
  error: string | null;
}

const INPUT_CLASS =
  "w-full px-3 py-3 rounded-[var(--radius-sm)] bg-[var(--bg-base)] border border-[var(--border-default)] text-base text-[var(--text-primary)] placeholder:text-[var(--text-faint)] outline-none focus-visible:border-[var(--accent)] focus-visible:shadow-[var(--focus-ring)] font-mono aria-[invalid=true]:border-[var(--status-error)] disabled:opacity-60";

/** Pulls a 64-hex access key out of pasted text (bare key or full #k= link). */
function extractAccessKey(raw: string): string | null {
  const match = /[0-9a-f]{64}/i.exec(raw.trim());
  return match ? match[0].toLowerCase() : null;
}

const SHAKE_STYLE = `
@keyframes ftown-shake {
  20% { transform: translateX(-6px); }
  40% { transform: translateX(5px); }
  60% { transform: translateX(-4px); }
  80% { transform: translateX(3px); }
}
.ftown-shake { animation: ftown-shake 0.4s ease-in-out both; }
@media (prefers-reduced-motion: reduce) {
  .ftown-shake { animation: none; }
}
`;

export function KeyEntry({ onSubmit, submitting, error }: KeyEntryProps) {
  const [value, setValue] = useState("");
  const [formatError, setFormatError] = useState<string | null>(null);
  const [shaking, setShaking] = useState(false);

  const displayError = formatError ?? error;

  useEffect(() => {
    if (!displayError) return undefined;
    setShaking(true);
    const timer = window.setTimeout(() => setShaking(false), 500);
    return () => window.clearTimeout(timer);
  }, [displayError]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = extractAccessKey(value);
    if (!key) {
      setFormatError("Paste the ftown link, or the 64-character key from the banner.");
      return;
    }
    setFormatError(null);
    onSubmit(key);
  }

  return (
    <div className="w-full max-w-md rounded-[var(--radius-md)] border border-[var(--border-muted)] bg-[var(--bg-surface)] p-6 sm:p-8">
      <style>{SHAKE_STYLE}</style>
      <h1 className="text-xl font-bold text-[var(--accent)] mb-2">ftown Solo</h1>
      <p className="text-[var(--text-secondary)] text-sm mb-8 font-[family-name:var(--font-sans)]">
        Connect this device to your bridge.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className={shaking ? "ftown-shake" : undefined}>
          <label htmlFor="solo-key" className="block text-sm text-[var(--text-secondary)] mb-1">
            Access key
          </label>
          <input
            id="solo-key"
            name="solo-key"
            type="password"
            inputMode="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="http://ftown.local:8040/#k=…"
            aria-label="ftown access key"
            aria-invalid={displayError ? true : undefined}
            aria-describedby={displayError ? "solo-key-error" : "solo-key-hint"}
            disabled={submitting}
            className={INPUT_CLASS}
          />
          <p
            id="solo-key-hint"
            className="mt-2 text-xs text-[var(--text-faint)] font-[family-name:var(--font-sans)]"
          >
            Paste the ftown link or key printed by{" "}
            <code className="font-[family-name:var(--font-mono)]">ftown-bridge --solo</code>.
          </p>
        </div>

        {displayError && (
          <div
            id="solo-key-error"
            role="alert"
            aria-live="assertive"
            className="fade-in flex items-start gap-2 px-3 py-2 rounded-[var(--radius-sm)] bg-[rgba(255,68,102,0.08)] border border-[var(--status-error)] text-[var(--status-error)] text-sm"
          >
            <span aria-hidden="true">⚠</span>
            <span>{displayError}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || value.trim().length === 0}
          className="btn-accent w-full !py-3 flex items-center justify-center gap-2"
        >
          {submitting && (
            <span
              className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"
              aria-hidden="true"
            />
          )}
          {submitting ? "Connecting…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
