import jwt from "jsonwebtoken";
import { CENTRIFUGO_TOKEN_SECRET, BRIDGE_BOOTSTRAP_AUDIENCE } from "./config";

/**
 * Mint the bridge bootstrap JWT. Mirrors /api/auth/bridge/bootstrap: the
 * distinct "ftown:bridge-bootstrap" audience that /api/auth/bridge now requires
 * (F1). A plain connect token — aud "ftown:centrifugo" — is rejected there.
 */
export function mintBridgeBootstrapToken(email: string): string {
  return jwt.sign({ sub: email }, CENTRIFUGO_TOKEN_SECRET, {
    audience: BRIDGE_BOOTSTRAP_AUDIENCE,
    expiresIn: "10m",
  });
}
