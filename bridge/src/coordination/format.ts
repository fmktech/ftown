import {
  CARD_STATES,
  type Board,
  type BoardRollupKey,
  type SessionCard,
  type TreeEvent,
} from './contract.js';

const ROLLUP_ORDER: readonly BoardRollupKey[] = [...CARD_STATES, 'unset'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatLocalHHMM(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatBoardRow(card: SessionCard, nowMs: number): string {
  const state = card.declared?.state ?? '-';
  const activity = card.derived.activity;

  let idlePart = '';
  if (activity === 'idle') {
    const idleSinceMs =
      card.derived.idleSince !== undefined
        ? Date.parse(card.derived.idleSince)
        : NaN;
    const idleMin = Number.isNaN(idleSinceMs)
      ? 0
      : Math.max(0, Math.floor((nowMs - idleSinceMs) / 60_000));
    idlePart = ` idle ${idleMin}m`;
  }

  const headline = card.declared?.headline || '-';

  let suffix = '';
  if (card.derived.pr) {
    suffix += `  PR:${card.derived.pr.state}`;
  }
  if (card.derived.openAttention > 0) {
    suffix += `  !${card.derived.openAttention}`;
  }
  if (card.derived.unreadMail > 0) {
    suffix += `  ✉${card.derived.unreadMail}`;
  }
  if (card.stale) {
    suffix += '  (stale)';
  }

  return `${card.name} ${state} ${activity}${idlePart}  ${headline}${suffix}`;
}

export function formatBoard(board: Board, nowMs: number): string {
  if (board.cards.length === 0) {
    return 'no child sessions';
  }
  const rows = board.cards.map((card) => formatBoardRow(card, nowMs));
  const rollupParts: string[] = [];
  for (const key of ROLLUP_ORDER) {
    const count = board.rollup[key] ?? 0;
    if (count > 0) {
      rollupParts.push(`${count} ${key}`);
    }
  }
  if (rollupParts.length > 0) {
    rows.push(rollupParts.join(', '));
  }
  return rows.join('\n');
}

export function formatEvent(e: TreeEvent): string {
  const hhmm = formatLocalHHMM(e.ts);
  return `#${e.seq} ${hhmm} ${e.sessionName} ${e.kind}: ${e.summary}`;
}
