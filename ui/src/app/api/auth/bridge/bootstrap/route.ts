import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import { auth } from "@/lib/auth";
import { getRequiredSecret } from "@/lib/secrets";

/**
 * Mint a short-lived bridge BOOTSTRAP token (F1).
 *
 * Session-gated: only a logged-in user can obtain one. The resulting token has a
 * DISTINCT audience ("ftown:bridge-bootstrap") that /api/auth/bridge requires —
 * an ordinary Centrifugo connect token (aud "ftown:centrifugo") can no longer be
 * exchanged for a 30-day bridge refresh token. The token is intentionally
 * short-lived: it is used once, immediately, to onboard a bridge.
 */
export async function POST(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let secret: string;
  try {
    secret = getRequiredSecret("CENTRIFUGO_TOKEN_SECRET");
  } catch (err) {
    console.error(
      "[auth/bridge/bootstrap] secret misconfiguration:",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const token = jwt.sign(
    { sub: session.user.email },
    secret,
    { audience: "ftown:bridge-bootstrap", expiresIn: "10m" },
  );

  return NextResponse.json({ token });
}
