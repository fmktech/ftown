import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";

import { parseLocalAdvert } from "../local-advert";
import { getRequiredSecret } from "@/lib/secrets";
import { rotateBridgeRefreshJti } from "@/lib/bridge-refresh";
import { isValidBridgeLabel } from "@/lib/bridge-label";

interface BridgeRefreshRequestBody {
  refreshToken: string;
  bridgeId: string;
  hostname: string;
  /** Loopback WS rung advert (optional; unchanged across refreshes in one bridge process). */
  localPort?: unknown;
  localNonce?: unknown;
}

interface BridgeRefreshPayload {
  sub: string;
  bridgeId: string;
  type: string;
  jti?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let secret: string;
  try {
    secret = getRequiredSecret("CENTRIFUGO_TOKEN_SECRET");
  } catch (err) {
    console.error(
      "[auth/bridge/refresh] secret misconfiguration:",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  let body: BridgeRefreshRequestBody;
  try {
    body = (await request.json()) as BridgeRefreshRequestBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  if (!body.refreshToken || !isValidBridgeLabel(body.bridgeId) || !isValidBridgeLabel(body.hostname)) {
    return NextResponse.json(
      { error: "refreshToken, bridgeId, and hostname are required" },
      { status: 400 }
    );
  }

  let decoded: BridgeRefreshPayload;
  try {
    decoded = jwt.verify(body.refreshToken, secret, { audience: "ftown:bridge-refresh" }) as BridgeRefreshPayload;
  } catch {
    return NextResponse.json(
      { error: "Invalid or expired refresh token" },
      { status: 401 }
    );
  }

  if (decoded.type !== "bridge_refresh") {
    return NextResponse.json(
      { error: "Invalid token type" },
      { status: 401 }
    );
  }

  if (decoded.bridgeId !== body.bridgeId) {
    return NextResponse.json(
      { error: "bridgeId mismatch" },
      { status: 401 }
    );
  }

  if (!decoded.jti) {
    return NextResponse.json(
      { error: "Refresh token missing jti" },
      { status: 401 }
    );
  }

  const advert = parseLocalAdvert(body);
  if (advert && "error" in advert) {
    return NextResponse.json({ error: advert.error }, { status: 400 });
  }

  // F3: rotate. Atomically verify this token's jti is the current one for the
  // bridge and swap in a fresh jti. A stale/reused/superseded token fails here.
  const nextJti = randomUUID();
  const rotated = await rotateBridgeRefreshJti(body.bridgeId, decoded.sub, decoded.jti, nextJti);
  if (!rotated) {
    return NextResponse.json(
      { error: "Refresh token has been rotated or revoked" },
      { status: 401 }
    );
  }

  const token = jwt.sign(
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
    { audience: "ftown:centrifugo", expiresIn: "24h" }
  );

  const refreshToken = jwt.sign(
    {
      sub: decoded.sub,
      bridgeId: body.bridgeId,
      type: "bridge_refresh",
      jti: nextJti,
    },
    secret,
    { audience: "ftown:bridge-refresh", expiresIn: "30d" },
  );

  return NextResponse.json({
    token,
    refreshToken,
    userId: decoded.sub,
    centrifugoUrl: process.env.NEXT_PUBLIC_CENTRIFUGO_URL,
  });
}
