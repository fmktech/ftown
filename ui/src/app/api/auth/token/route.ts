import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import { auth } from "@/lib/auth";

export async function POST(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const secret = process.env.CENTRIFUGO_TOKEN_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CENTRIFUGO_TOKEN_SECRET not configured" },
      { status: 500 }
    );
  }

  const token = jwt.sign({ sub: session.user.email }, secret, { audience: "ftown:centrifugo", expiresIn: "24h" });

  return NextResponse.json({
    token,
    centrifugoUrl: process.env.NEXT_PUBLIC_CENTRIFUGO_URL,
  });
}
