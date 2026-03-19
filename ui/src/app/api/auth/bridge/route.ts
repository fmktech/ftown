import { NextRequest, NextResponse } from "next/server";
import jwt from "jsonwebtoken";

interface BridgeTokenRequestBody {
  token: string;
  bridgeId: string;
  hostname: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CENTRIFUGO_TOKEN_SECRET;

  if (!secret) {
    return NextResponse.json(
      { error: "CENTRIFUGO_TOKEN_SECRET not configured" },
      { status: 500 }
    );
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

  if (!body.token || !body.bridgeId || !body.hostname) {
    return NextResponse.json(
      { error: "token, bridgeId, and hostname are required" },
      { status: 400 }
    );
  }

  let decoded: { sub: string };
  try {
    decoded = jwt.verify(body.token, secret) as { sub: string };
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

  const centrifugoToken = jwt.sign(
    {
      sub: decoded.sub,
      info: {
        bridgeId: body.bridgeId,
        hostname: body.hostname,
        connectedAt: new Date().toISOString(),
      },
    },
    secret,
    { expiresIn: "24h" },
  );

  const centrifugoUrl = process.env.NEXT_PUBLIC_CENTRIFUGO_URL;

  return NextResponse.json({
    token: centrifugoToken,
    centrifugoUrl,
    userId: decoded.sub,
  });
}
