import jwt from "jsonwebtoken";
import { CENTRIFUGO_TOKEN_SECRET, TOKEN_AUDIENCE } from "./config";

/**
 * Mint the bridge bootstrap JWT. Same params as ui/src/app/api/auth/token/route.ts
 * and accepted by /api/auth/bridge (jwt.verify with audience "ftown:centrifugo").
 */
export function mintBridgeBootstrapToken(email: string): string {
  return jwt.sign({ sub: email }, CENTRIFUGO_TOKEN_SECRET, {
    audience: TOKEN_AUDIENCE,
    expiresIn: "24h",
  });
}
