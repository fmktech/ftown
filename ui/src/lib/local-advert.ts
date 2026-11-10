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
}): { localPort: number } | null | { error: string } {
  if (body.localPort === undefined) return null;
  if (
    typeof body.localPort !== "number" ||
    !Number.isInteger(body.localPort) ||
    body.localPort < 1 ||
    body.localPort > 65535
  ) {
    return { error: "localPort must be an integer between 1 and 65535" };
  }
  // A port is discovery metadata. Never advertise an authorization capability.
  return { localPort: body.localPort };
}
