import {
  CARD_STATES,
  type Board,
  type BoardRollupKey,
  type SessionCard,
  type TreeEvent,
} from './contract.js';

const ROLLUP_ORDER: readonly BoardRollupKey[] = [...CARD_STATES, 'unset'];

const BLOCKED_TEXT_MAX = 60;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function truncate(text: string, max: number): string {
  return [...text].slice(0, max).join('');
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
  const progress = card.declared?.progress;
  if (progress && state !== 'done') {
    suffix += `  ${progress.done}/${progress.total}`;
  }
  const blockedOn = card.declared?.blockedOn;
  if (blockedOn) {
    const ref = blockedOn.ref ? `:${blockedOn.ref}` : '';
    suffix += `  blocked on ${blockedOn.kind}${ref}: ${truncate(blockedOn.text, BLOCKED_TEXT_MAX)}`;
  }
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
  if (card.archived) {
    suffix += '  (retired)';
  }

  return `${card.name} ${state} ${activity}${idlePart}  ${headline}${suffix}`;
}

const PLANNED_READY_LIMIT = 5;

function formatPlannedLines(board: Board): string[] {
  const ready = board.plan?.ready ?? [];
  if (ready.length === 0) return [];
  const titleById = new Map((board.plan?.items ?? []).map((item) => [item.id, item.title]));
  const shown = ready.slice(0, PLANNED_READY_LIMIT);
  const lines = ['planned'];
  for (const id of shown) {
    const title = titleById.get(id) ?? '';
    lines.push(title === '' ? `→ ${id}` : `→ ${id} ${title}`);
  }
  const more = ready.length - shown.length;
  if (more > 0) lines.push(`+${more} more`);
  return lines;
}

export function formatBoard(board: Board, nowMs: number): string {
  const lines: string[] = [];
  if (board.cards.length === 0) {
    lines.push('no child sessions');
  } else {
    for (const card of board.cards) {
      lines.push(formatBoardRow(card, nowMs));
    }
    const rollupParts: string[] = [];
    for (const key of ROLLUP_ORDER) {
      const count = board.rollup[key] ?? 0;
      if (count > 0) {
        rollupParts.push(`${count} ${key}`);
      }
    }
    if (rollupParts.length > 0) {
      lines.push(rollupParts.join(', '));
    }
  }
  lines.push(...formatPlannedLines(board));
  return lines.join('\n');
}

export function formatEvent(e: TreeEvent): string {
  const hhmm = formatLocalHHMM(e.ts);
  return `#${e.seq} ${hhmm} ${e.sessionName} ${e.kind}: ${e.summary}`;
}
