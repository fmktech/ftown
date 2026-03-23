import { NextRequest, NextResponse } from "next/server";
import jwt from "jsonwebtoken";

interface BridgeRefreshRequestBody {
  refreshToken: string;
  bridgeId: string;
  hostname: string;
}

interface BridgeRefreshPayload {
  sub: string;
  bridgeId: string;
  type: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CENTRIFUGO_TOKEN_SECRET;

  if (!secret) {
    return NextResponse.json(
      { error: "CENTRIFUGO_TOKEN_SECRET not configured" },
      { status: 500 }
    );
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

  if (!body.refreshToken || !body.bridgeId || !body.hostname) {
    return NextResponse.json(
      { error: "refreshToken, bridgeId, and hostname are required" },
      { status: 400 }
    );
  }

  let decoded: BridgeRefreshPayload;
  try {
    decoded = jwt.verify(body.refreshToken, secret) as BridgeRefreshPayload;
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

  const token = jwt.sign(
    {
      sub: decoded.sub,
      info: {
        bridgeId: body.bridgeId,
        hostname: body.hostname,
        connectedAt: new Date().toISOString(),
      },
    },
    secret,
    { expiresIn: "24h" }
  );

  return NextResponse.json({ token });
}
