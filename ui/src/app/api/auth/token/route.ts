import { NextRequest, NextResponse } from "next/server";
import jwt from "jsonwebtoken";

interface TokenRequestBody {
  userId: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CENTRIFUGO_TOKEN_SECRET;

  if (!secret) {
    return NextResponse.json(
      { error: "CENTRIFUGO_TOKEN_SECRET not configured" },
      { status: 500 }
    );
  }

  let body: TokenRequestBody;
  try {
    body = (await request.json()) as TokenRequestBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  if (!body.userId || typeof body.userId !== "string") {
    return NextResponse.json(
      { error: "userId is required and must be a string" },
      { status: 400 }
    );
  }

  const payload = {
    sub: body.userId,
  };

  const token = jwt.sign(payload, secret, {
    expiresIn: "24h",
  });

  return NextResponse.json({ token });
}
