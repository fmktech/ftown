/**
 * Client-IP extraction for rate-limit keys.
 *
 * Trust is derived from verified ingress, never from a header name alone:
 *  - `fly-client-ip` is only honoured when actually running on Fly
 *    (`FLY_APP_NAME`/`FLY_MACHINE_ID` set), where Fly strips client copies.
 *  - `x-real-ip` / `x-forwarded-for` are only honoured when the platform or the
 *    operator is known to overwrite them: Vercel (`VERCEL` set) replaces
 *    externally supplied forwarding IPs, and self-hosted reverse proxies opt in
 *    with `FTOWN_TRUSTED_PROXY=1`.
 *  - Otherwise the key is the constant "unknown" (fail closed) rather than a
 *    spoofable per-request value.
 */
function onFly(): boolean {
  return Boolean(process.env.FLY_APP_NAME || process.env.FLY_MACHINE_ID);
}

function trustsProxyHeaders(): boolean {
  const value = process.env.FTOWN_TRUSTED_PROXY;
  return value === "1" || value?.toLowerCase() === "true" || Boolean(process.env.VERCEL);
}

export function clientIp(request: Request): string {
  if (onFly()) {
    const fly = request.headers.get("fly-client-ip");
    if (fly?.trim()) return fly.trim();
  }

  if (trustsProxyHeaders()) {
    const realIp = request.headers.get("x-real-ip");
    if (realIp?.trim()) return realIp.trim();

    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded) {
      const parts = forwarded.split(",").map((p) => p.trim()).filter(Boolean);
      const nearestProxy = parts[parts.length - 1];
      if (nearestProxy) return nearestProxy;
    }
  }

  return "unknown";
}
