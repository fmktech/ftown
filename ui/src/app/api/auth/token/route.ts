import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";
import { auth } from "@/lib/auth";
import { getRequiredSecret } from "@/lib/secrets";

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
      "[auth/token] secret misconfiguration:",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const token = jwt.sign({ sub: session.user.email }, secret, { audience: "ftown:centrifugo", expiresIn: "24h" });

  return NextResponse.json({
    token,
    centrifugoUrl: process.env.NEXT_PUBLIC_CENTRIFUGO_URL,
  });
}
