/** Require one canonical browser Origin, never a Host/forwarded-header reconstruction. */
function canonicalOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if (value !== url.origin || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
    return url;
  } catch { return null; }
}

/**
 * Preserve the exact request origin and additionally trust an operator-provisioned
 * public origin when Next reconstructs an internal listener URL behind a proxy.
 * A present but malformed configuration must not silently enable the fallback.
 */
export function isTrustedBrowserOrigin(request: Request, publicOrigin: string | undefined = process.env.FTOWN_PUBLIC_URL): boolean {
  if (publicOrigin !== undefined) {
    const configured = canonicalOrigin(publicOrigin);
    if (!configured || (configured.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname))) return false;
  }
  const origin = request.headers.get('origin');
  if (origin === null || !canonicalOrigin(origin)) return false;
  try { return origin === new URL(request.url).origin || origin === publicOrigin; }
  catch { return false; }
}
