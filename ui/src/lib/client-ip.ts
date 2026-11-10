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

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** The eight 16-bit groups of an IPv6 address (zone id dropped, an embedded IPv4 tail accepted), or null when it is not one. */
function ipv6Groups(text: string): number[] | null {
  let value = text.split("%")[0];
  if (!value.includes(":") || !/^[0-9A-Fa-f:.]+$/.test(value)) return null;
  const lastColon = value.lastIndexOf(":");
  const tail = value.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!IPV4.test(tail)) return null;
    const [a, b, c, d] = tail.split(".").map(Number);
    value = `${value.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const items = part.split(":");
    return items.every((item) => /^[0-9A-Fa-f]{1,4}$/.test(item)) ? items.map((item) => parseInt(item, 16)) : null;
  };
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  return missing >= 1 ? [...head, ...new Array<number>(missing).fill(0), ...rest] : null;
}

/**
 * A client address as a rate-limit key. One IPv6 subscriber usually holds a whole /64, so an IPv6 address is bucketed to its /64
 * ("2001:db8:1:2::/64"); an IPv4-mapped IPv6 address (::ffff:a.b.c.d) is its IPv4 address; IPv4 is itself without any port.
 * "unknown" and anything that does not parse are returned unchanged. Bracketed forms with a port ("[2001:db8::1]:443") are accepted.
 */
export function rateLimitKey(ip: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip.trim());
  const bare = bracketed ? bracketed[1] : ip.trim();
  // IPv4 with a port ("203.0.113.7:443", "[203.0.113.7]:443"): the port is not part of the key.
  const withPort = /^([0-9.]+):\d{1,5}$/.exec(bare);
  if (withPort && IPV4.test(withPort[1])) return withPort[1];
  if (IPV4.test(bare)) return bare;
  const groups = ipv6Groups(bare);
  if (!groups) return ip;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}

/** clientIp() bucketed for rate limiting (see rateLimitKey). clientIp() itself is unchanged for its other callers. */
export function rateLimitKeyIp(request: Request): string {
  return rateLimitKey(clientIp(request));
}
