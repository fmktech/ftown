import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";

import { parseLocalAdvert } from "./local-advert";
import { getRequiredSecret } from "@/lib/secrets";
import { setBridgeRefreshJti } from "@/lib/bridge-refresh";
import { isValidBridgeLabel } from "@/lib/bridge-label";

interface BridgeTokenRequestBody {
  token: string;
  bridgeId: string;
  hostname: string;
  /** Loopback WS rung advert (optional; absent on old bridges). */
  localPort?: unknown;
  localNonce?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let secret: string;
  try {
    secret = getRequiredSecret("CENTRIFUGO_TOKEN_SECRET");
  } catch (err) {
    console.error(
      "[auth/bridge] secret misconfiguration:",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  let body: BridgeTokenRequestBody;
  try {
    body = (await request.json()) as BridgeTokenRequestBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  if (!body.token || !isValidBridgeLabel(body.bridgeId) || !isValidBridgeLabel(body.hostname)) {
    return NextResponse.json(
      { error: "token, bridgeId, and hostname are required" },
      { status: 400 }
    );
  }

  // F1: only a session-gated bootstrap token (distinct audience) may be
  // exchanged for a bridge identity + 30-day refresh token. A plain Centrifugo
  // connect token (aud "ftown:centrifugo") is rejected here.
  let decoded: { sub: string };
  try {
    decoded = jwt.verify(body.token, secret, {
      audience: "ftown:bridge-bootstrap",
    }) as { sub: string };
  } catch {
    return NextResponse.json(
      { error: "Invalid or expired token" },
      { status: 401 }
    );
  }

  if (!decoded.sub) {
    return NextResponse.json(
      { error: "Token missing sub claim" },
      { status: 401 }
    );
  }

  const advert = parseLocalAdvert(body);
  if (advert && "error" in advert) {
    return NextResponse.json({ error: advert.error }, { status: 400 });
  }

  const centrifugoToken = jwt.sign(
    {
      sub: decoded.sub,
      info: {
        bridgeId: body.bridgeId,
        hostname: body.hostname,
        connectedAt: new Date().toISOString(),
        ...(advert ?? {}),
      },
    },
    secret,
    { audience: "ftown:centrifugo", expiresIn: "24h" },
  );

  // F3: establish the current refresh jti for this bridge and embed it. A
  // re-bootstrap deliberately supersedes any previously issued refresh token.
  const refreshJti = randomUUID();
  await setBridgeRefreshJti(body.bridgeId, decoded.sub, refreshJti);

  const refreshToken = jwt.sign(
    {
      sub: decoded.sub,
      bridgeId: body.bridgeId,
      type: "bridge_refresh",
      jti: refreshJti,
    },
    secret,
    { audience: "ftown:bridge-refresh", expiresIn: "30d" },
  );

  const centrifugoUrl = process.env.NEXT_PUBLIC_CENTRIFUGO_URL;

  return NextResponse.json({
    token: centrifugoToken,
    refreshToken,
    centrifugoUrl,
    userId: decoded.sub,
  });
}
