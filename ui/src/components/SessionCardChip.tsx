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

/**
 * Per-state glyph and colour for the plain text line, reusing glyphs and colour
 * tokens already used elsewhere in the UI (▸ collapse arrows, ✓/✗ stream status,
 * ⚠ warning badges, --accent, --status-* and --shell-generic tokens).
 */
const CHIP_ICONS: Record<CardState, string> = {
  working: "▸",
  blocked: "⚠",
  waiting_review: "◷",
  done: "✓",
  failed: "✗",
};

const CHIP_COLORS: Record<CardState, string> = {
  working: "var(--accent)",
  blocked: "var(--status-pending)",
  // Blue is already themed for generic badges (--shell-generic); keeps review distinct from blocked amber.
  waiting_review: "var(--shell-generic)",
  done: "var(--text-secondary)",
  failed: "var(--status-error)",
};

export interface SessionCardChipProps {
  card?: SessionCard;
  /** Omit the headline for very narrow inline rows (e.g. the overview table). */
  compact?: boolean;
}

/**
 * Declared card state rendered as a plain text line — icon + coloured text, no
 * border/background — mirroring the hook activity line ("⚙ using Bash") in font
 * size and indentation. Full mode spans the row width and truncates with
 * ellipsis; compact stays inline for narrow table cells and omits the headline.
 */
export function SessionCardChip({ card, compact = false }: SessionCardChipProps) {
  if (!card) return null;

  const blockedOn = card.state === "blocked" ? card.blockedOn : undefined;
  const stateText = blockedOn ? `blocked on ${blockedOn.kind}` : cardStateLabel(card.state);
  const progressText = card.progress && card.progress.total > 0 && card.state !== "done"
    ? `${card.progress.done}/${card.progress.total}`
    : null;
  const summary = card.headline || blockedOn?.text || "";
  const ariaLabel = `${stateText}${progressText ? ` ${progressText}` : ""}${summary ? `: ${summary}` : ""}`;
  const text = [progressText ? `${stateText} ${progressText}` : stateText, summary]
    .filter(Boolean)
    .join(blockedOn ? ": " : " · ");

  const color = CHIP_COLORS[card.state];
  const icon = (
    <span aria-hidden style={{ fontStyle: "normal", marginRight: 4, flexShrink: 0 }}>
      {CHIP_ICONS[card.state]}
    </span>
  );

  if (compact) {
    const compactText = progressText ? `${stateText} ${progressText}` : stateText;
    return (
      <span
        role="img"
        aria-label={ariaLabel}
        title={compactText}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 9,
          fontWeight: 600,
          fontFamily: "var(--font-mono)",
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
          color,
        }}
      >
        {icon}
        <span aria-hidden>{compactText}</span>
      </span>
    );
  }

  return (
    <span
      role="img"
      aria-label={ariaLabel}
      title={text}
      style={{
        display: "flex",
        minWidth: 0,
        fontSize: 10,
        fontStyle: "italic",
        fontFamily: "var(--font-mono)",
        fontVariantNumeric: "tabular-nums",
        lineHeight: 1.4,
        overflow: "hidden",
        whiteSpace: "nowrap",
        color,
      }}
    >
      {icon}
      <span
        aria-hidden
        style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {text}
      </span>
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
