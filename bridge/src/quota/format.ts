import type { ProviderQuota, QuotaStatus, QuotaTableFormatter, QuotaWindow } from './types.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const HEADERS = ['PROVIDER', 'PLAN', '5H LEFT', 'WEEKLY LEFT', 'SOURCE'] as const;

/** Human duration: "6d 14h", "2h 0m", "59m", or "<1m" below a minute. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '<1m';
  if (ms >= DAY_MS) {
    const days = Math.floor(ms / DAY_MS);
    const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
    return `${days}d ${hours}h`;
  }
  if (ms >= HOUR_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
    return `${hours}h ${minutes}m`;
  }
  if (ms >= MINUTE_MS) {
    return `${Math.floor(ms / MINUTE_MS)}m`;
  }
  return '<1m';
}

function statusOnlyCell(status: QuotaStatus): string {
  switch (status) {
    case 'ok':
      return '-';
    case 'no_data':
      return 'no data';
    case 'auth':
      return 'login needed';
    case 'unavailable':
      return 'unavailable';
    case 'error':
      return 'error';
  }
}

/** Cell text for one window column (5H LEFT or WEEKLY LEFT). */
export function formatWindowCell(
  window: QuotaWindow | undefined,
  status: QuotaStatus,
  now: Date,
): string {
  if (window === undefined) return statusOnlyCell(status);

  const used = window.usedPercent;
  const hasUsed = used !== null && Number.isFinite(used);
  const note = window.note?.trim() ?? '';

  let text: string;
  if (hasUsed) {
    const left = Math.min(100, Math.max(0, 100 - used));
    text = `${Math.round(left)}%`;
  } else if (note.length > 0) {
    text = note;
  } else {
    text = '?';
  }

  if (window.resetsAt !== null) {
    const resetMs = Date.parse(window.resetsAt);
    if (!Number.isNaN(resetMs)) {
      const nowMs = now.getTime();
      text +=
        resetMs > nowMs
          ? ` (resets in ${formatDuration(resetMs - nowMs)})`
          : ' (reset due)';
    }
  }
  return text;
}

function sourceCell(row: ProviderQuota, now: Date): string {
  if (row.source === 'live') return 'live';
  const observedMs = Date.parse(row.observedAt);
  if (Number.isNaN(observedMs)) return 'cached';
  return `cached ${formatDuration(now.getTime() - observedMs)} ago`;
}

function planCell(plan: string | null): string {
  return plan !== null && plan.trim().length > 0 ? plan : '-';
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function renderLines(cells: readonly (readonly string[])[]): string[] {
  const widths = HEADERS.map((_, col) => Math.max(...cells.map((row) => row[col].length)));
  return cells.map((row) =>
    row
      .map((cell, col) => (col === row.length - 1 ? cell : padRight(cell, widths[col])))
      .join('  ')
      .trimEnd(),
  );
}

export const formatQuotaTable: QuotaTableFormatter = (rows, now) => {
  const body: string[][] = rows.map((row) => {
    const fiveHour = row.windows.find((w) => w.kind === 'five_hour');
    const weekly = row.windows.find((w) => w.kind === 'weekly');
    return [
      row.provider,
      planCell(row.plan),
      formatWindowCell(fiveHour, row.status, now),
      formatWindowCell(weekly, row.status, now),
      sourceCell(row, now),
    ];
  });

  const lines = renderLines([[...HEADERS], ...body]);

  const messages: string[] = [];
  for (const row of rows) {
    const message = row.message?.trim() ?? '';
    if (message.length > 0) messages.push(`${row.provider}: ${message}`);
  }
  if (messages.length > 0) {
    lines.push('', ...messages);
  }
  return lines.join('\n');
};
