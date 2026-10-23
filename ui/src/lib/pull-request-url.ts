export interface PullRequestReference {
  url: string;
  repository: string;
  number: number;
}

/** Treat bridge metadata as untrusted; never fetch or render an unchecked URL. */
export function parsePullRequestUrl(value: unknown): PullRequestReference | null {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
  const input = value.trim();
  if (!input) return null;
  let destination: URL;
  try { destination = new URL(input); } catch { return null; }
  if (destination.protocol !== "https:" || destination.hostname !== "github.com" || destination.username || destination.password || destination.port) return null;
  // Match the original path before URL parsing can normalize dot segments,
  // backslashes or encoded separators into a different destination.
  const originalPath = /^https:\/\/[^/?#]+(\/[^?#]*)/i.exec(input)?.[1];
  const match = originalPath?.match(/^\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)\/pull\/([0-9]+)\/?$/);
  if (!match || match[2] === "." || match[2] === "..") return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const repository = `${match[1]}/${match[2]}`;
  return { url: `https://github.com/${repository}/pull/${number}`, repository, number };
}
