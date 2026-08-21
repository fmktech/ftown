/**
 * Client-IP extraction for rate-limit keys.
 *
 * Preference order: platform-injected headers first (Fly sets Fly-Client-Ip and
 * strips client-supplied copies), then x-real-ip, then the RIGHTMOST
 * x-forwarded-for entry (added by the nearest trusted proxy; leftmost entries
 * are attacker-controllable). Self-hosted deployments without a trusted proxy
 * that overwrites these headers should not rely on the derived key for strong
 * limiting.
 */
export function clientIp(request: Request): string {
  const fly = request.headers.get("fly-client-ip");
  if (fly?.trim()) return fly.trim();

  const realIp = request.headers.get("x-real-ip");
  if (realIp?.trim()) return realIp.trim();

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded.split(",").map((p) => p.trim()).filter(Boolean);
    const nearestProxy = parts[parts.length - 1];
    if (nearestProxy) return nearestProxy;
  }

  return "unknown";
}
