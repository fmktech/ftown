/** Validate a GitHub PR destination without making a network request. */
export function normalizePullRequestUrl(value: string): string {
  const invalid = () => new Error('Invalid pullRequestUrl: expected a GitHub HTTPS pull request URL');
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f\\]/.test(value)) throw invalid();
  const trimmed = value.trim();
  let url: URL;
  try { url = new URL(trimmed); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) throw invalid();
  // Inspect the original path too: URL parsing normalizes dot segments, which
  // must not turn an otherwise invalid destination into an accepted PR link.
  const rawPath = /^https:\/\/[^/?#]+(\/[^?#]*)/i.exec(trimmed)?.[1];
  const match = rawPath?.match(/^\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)\/pull\/([0-9]+)\/?$/);
  if (!match || match[2] === '.' || match[2] === '..') throw invalid();
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) throw invalid();
  return `https://github.com/${match[1]}/${match[2]}/pull/${number}`;
}
