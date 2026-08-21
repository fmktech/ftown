const MIN_SECRET_LENGTH = 32;

// Matches the placeholder values shipped in .env.example / README quick-start
// snippets. A deployed instance must never sign tokens with one of these.
const PLACEHOLDER_RE = /change-me/i;

/**
 * Fail-fast accessor for security-critical secrets.
 *
 * Refuses to hand back a missing or weak secret so that no route can ever sign
 * a token with an absent/short key. The thrown error references only the env
 * var NAME — never the value — so it is safe to log.
 */
export function getRequiredSecret(name: string): string {
  const value = process.env[name];
  if (!value || value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${name} is missing or too weak: it must be set to at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  if (PLACEHOLDER_RE.test(value)) {
    throw new Error(`${name} is still set to its example placeholder — generate a real secret`);
  }
  return value;
}
