/**
 * Client-IP extraction for rate-limit keys.
 *
 * Trust model:
 *  - `fly-client-ip` is platform-injected (Fly strips client-supplied copies), so
 *    it is always trusted.
 *  - `x-real-ip` / `x-forwarded-for` are only trusted when the operator opts in
 *    with `FTOWN_TRUSTED_PROXY=1`, i.e. a reverse proxy is guaranteed to
 *    overwrite them. Otherwise they are attacker-controllable and keying on
 *    them lets an anonymous client rotate the rate-limit bucket freely.
 *  - With no trusted source the key is the constant "unknown": the limiter then
 *    applies globally (fail closed) rather than being bypassable per request.
 *    Self-hosted deployments behind a proxy should set FTOWN_TRUSTED_PROXY=1.
 */
function trustsProxyHeaders(): boolean {
  const value = process.env.FTOWN_TRUSTED_PROXY;
  return value === "1" || value?.toLowerCase() === "true";
}

export function clientIp(request: Request): string {
  const fly = request.headers.get("fly-client-ip");
  if (fly?.trim()) return fly.trim();

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
