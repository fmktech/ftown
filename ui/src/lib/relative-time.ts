/**
 * The one relative-time formatter for the whole UI.
 *
 * Accepts an epoch-ms number, a Date, or a string (ISO date string, or a
 * purely numeric string treated as epoch ms). Handles both past and future
 * times on one ladder:
 *
 *   past:    "just now" (<5s) → "37s ago" → "12m ago" → "5h ago" → "3d ago"
 *   future:  "in 37s" → "in 12m" → "in 5h" → "in 3d"
 *   ≥7 days either way: short local date, e.g. "Jul 21"
 *
 * Returns "" for an empty-string input (a caller-side "no timestamp yet")
 * and "unknown" for anything unparseable.
 */
export function relativeTime(
  input: number | string | Date,
  now: number = Date.now(),
): string {
  if (typeof input === "string" && input.trim() === "") return "";
  const ms = toEpochMs(input);
  if (ms === null) return "unknown";

  const diff = now - ms;
  const abs = Math.abs(diff);
  if (abs < 5000) return "just now";

  const s = Math.floor(abs / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);

  if (d >= 7) {
    return new Date(ms).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }

  const unit = d >= 1 ? `${d}d` : h >= 1 ? `${h}h` : m >= 1 ? `${m}m` : `${s}s`;
  return diff >= 0 ? `${unit} ago` : `in ${unit}`;
}

function toEpochMs(input: number | string | Date): number | null {
  if (input instanceof Date) {
    const t = input.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof input === "number") {
    return Number.isNaN(input) ? null : input;
  }
  const trimmed = input.trim();
  // Purely numeric strings are epoch milliseconds (e.g. Cursor's updatedAtMs).
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const t = new Date(trimmed).getTime();
  return Number.isNaN(t) ? null : t;
}
