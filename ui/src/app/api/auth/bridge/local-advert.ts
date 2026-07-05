/**
 * Validates the optional loopback WS rung advert sent by the bridge in its
 * auth/refresh request bodies. Returns the advert to embed in the Centrifugo
 * connection JWT `info` claim, null when absent (old bridges), or an error
 * string for junk values. The advert is presence-visible to the owning user's
 * clients only (loopback addendum L2). Never log these values.
 */
export function parseLocalAdvert(body: {
  localPort?: unknown;
  localNonce?: unknown;
}): { localPort: number; localNonce: string } | null | { error: string } {
  if (body.localPort === undefined && body.localNonce === undefined) return null;
  if (
    typeof body.localPort !== "number" ||
    !Number.isInteger(body.localPort) ||
    body.localPort < 1 ||
    body.localPort > 65535
  ) {
    return { error: "localPort must be an integer between 1 and 65535" };
  }
  if (typeof body.localNonce !== "string" || !/^[0-9a-f]{32}$/.test(body.localNonce)) {
    return { error: "localNonce must be a 32-character lowercase hex string" };
  }
  return { localPort: body.localPort, localNonce: body.localNonce };
}
