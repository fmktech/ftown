const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** The canonical public origin of this server (FTOWN_PUBLIC_URL). Never derived from request headers. */
export function publicOrigin(): string {
  const configured = process.env.FTOWN_PUBLIC_URL;
  if (configured === undefined || configured === '') {
    if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') return 'http://localhost:3000';
    throw new Error('FTOWN_PUBLIC_URL must be set');
  }
  let url: URL;
  try { url = new URL(configured); } catch { throw new Error('FTOWN_PUBLIC_URL is not a valid origin'); }
  if (configured !== url.origin) throw new Error('FTOWN_PUBLIC_URL must be a canonical origin (scheme://host[:port], no path or trailing slash)');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.indexOf(url.hostname) !== -1)) {
    throw new Error('FTOWN_PUBLIC_URL must be https (http only on loopback)');
  }
  return url.origin;
}

/** The WebAuthn rpId accounts must be bound to: FTOWN_RP_ID, else the public origin's hostname. */
export function expectedRpId(): string {
  return process.env.FTOWN_RP_ID ?? new URL(publicOrigin()).hostname;
}
