"use client";

/**
 * Shown while ftown Solo children (realtime hub, web panel) are still booting
 * or unreachable — the page polls /healthz every 2s and moves on as soon as
 * both report up. Quiet, honest progress; no spinner theater.
 */

interface StartingStateProps {
  /** Latest poll outcome, e.g. "Waiting for the realtime hub…". */
  detail?: string | null;
}

const DOTS_STYLE = `
@keyframes ftown-start-dot {
  0%, 100% { opacity: 0.25; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1); }
}
.ftown-start-dot { animation: ftown-start-dot 1.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .ftown-start-dot { animation: none; opacity: 0.6; }
}
`;

export function StartingState({ detail }: StartingStateProps) {
  return (
    <section
      aria-live="polite"
      aria-busy="true"
      className="fade-in w-full max-w-md rounded-[var(--radius-md)] border border-[var(--border-muted)] bg-[var(--bg-surface)] p-8 text-center"
    >
      <style>{DOTS_STYLE}</style>
      <div className="flex items-center justify-center gap-1.5 mb-5" aria-hidden="true">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="ftown-start-dot inline-block w-2 h-2 rounded-full bg-[var(--accent)]"
            style={{ animationDelay: `${dot * 0.18}s` }}
          />
        ))}
      </div>
      <h1 className="text-lg font-bold text-[var(--text-primary)] mb-2">Starting ftown Solo…</h1>
      <p className="text-sm text-[var(--text-secondary)] font-[family-name:var(--font-sans)]">
        This can take a minute on first run (downloading components).
      </p>
      {detail && (
        <p className="mt-4 text-xs text-[var(--text-faint)] font-[family-name:var(--font-mono)]">
          {detail}
        </p>
      )}
    </section>
  );
}
