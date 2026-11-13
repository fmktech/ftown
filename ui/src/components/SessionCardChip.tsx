import type { Session, SessionCard } from "@/types";

/** Mirrors the bridge contract's CARD_STATES order; kept local so the UI never runtime-imports bridge code. */
export type CardState = SessionCard["state"];
const CARD_STATES: readonly CardState[] = ["working", "blocked", "waiting_review", "done", "failed"];
export const CARD_STATE_LABELS: Record<CardState, string> = {
  working: "working",
  blocked: "blocked",
  waiting_review: "waiting review",
  done: "done",
  failed: "failed",
};

export function cardStateLabel(state: CardState): string {
  return CARD_STATE_LABELS[state];
}

/** Colours reuse the existing CSS variables/tokens; no global CSS is added. */
const CHIP_COLORS: Record<CardState, { fg: string; bg: string; border: string }> = {
  working: { fg: "var(--accent)", bg: "var(--accent-dim)", border: "rgba(0, 255, 136, 0.15)" },
  blocked: { fg: "var(--status-pending)", bg: "rgba(255, 170, 0, 0.08)", border: "rgba(255, 170, 0, 0.15)" },
  // Blue is already themed for generic badges (--shell-generic); keeps review distinct from blocked amber.
  waiting_review: { fg: "var(--shell-generic)", bg: "rgba(0, 191, 255, 0.08)", border: "rgba(0, 191, 255, 0.15)" },
  done: { fg: "var(--text-secondary)", bg: "transparent", border: "var(--border-muted)" },
  failed: { fg: "var(--status-error)", bg: "rgba(255, 68, 102, 0.08)", border: "rgba(255, 68, 102, 0.15)" },
};

export interface SessionCardChipProps {
  card?: SessionCard;
  /** Omit the headline and tighten padding for very narrow rows. */
  compact?: boolean;
}

/** Small declared-state chip (working / blocked / waiting review / done / failed) with headline + progress. */
export function SessionCardChip({ card, compact = false }: SessionCardChipProps) {
  if (!card) return null;

  const colors = CHIP_COLORS[card.state];
  const blockedOn = card.state === "blocked" ? card.blockedOn : undefined;
  const stateText = blockedOn ? `blocked on ${blockedOn.kind}` : cardStateLabel(card.state);
  const progressText = card.progress && card.progress.total > 0
    ? `${card.progress.done}/${card.progress.total}`
    : null;
  const summary = card.headline || blockedOn?.text || "";
  const ariaLabel = `${stateText}${progressText ? ` ${progressText}` : ""}${summary ? `: ${summary}` : ""}`;

  return (
    <span
      role="img"
      aria-label={ariaLabel}
      title={card.headline || stateText}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        maxWidth: 160,
        minWidth: 0,
        flexShrink: 1,
        overflow: "hidden",
        padding: compact ? "1px 4px" : "1px 6px",
        borderRadius: 8,
        fontSize: compact ? 9 : 10,
        fontWeight: 600,
        lineHeight: 1.4,
        fontFamily: "var(--font-mono)",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
        color: colors.fg,
        background: colors.bg,
        border: `1px solid ${colors.border}`,
      }}
    >
      <span
        aria-hidden
        title={blockedOn?.text || undefined}
        style={{ flexShrink: 0 }}
      >
        {stateText}
      </span>
      {progressText && (
        <span aria-hidden style={{ flexShrink: 0 }}>
          {progressText}
        </span>
      )}
      {!compact && card.headline && (
        <span
          aria-hidden
          style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {card.headline}
        </span>
      )}
    </span>
  );
}

export interface CardRollupEntry {
  state: CardState;
  count: number;
}

/**
 * Counts children of `parentId` by declared card state, in CARD_STATES order,
 * omitting zero counts. Children without a card are ignored.
 */
export function rollupChildCards(
  sessions: ReadonlyArray<Session>,
  parentId: string,
): CardRollupEntry[] {
  const counts: Record<CardState, number> = { working: 0, blocked: 0, waiting_review: 0, done: 0, failed: 0 };
  for (const session of sessions) {
    if (session.parentSessionId !== parentId || !session.card) continue;
    counts[session.card.state] += 1;
  }
  return CARD_STATES
    .filter((state) => counts[state] > 0)
    .map((state) => ({ state, count: counts[state] }));
}

/** `5 working · 1 blocked · 2 done`; empty string when there is nothing to show. */
export function formatCardRollup(entries: ReadonlyArray<CardRollupEntry>): string {
  return entries.map((entry) => `${entry.count} ${cardStateLabel(entry.state)}`).join(" · ");
}
