import { NextRequest, NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { denyPairingRequest } from "@/lib/pairing-store";

export const runtime = "nodejs";

interface PairDenyRequestBody {
  userCode: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: PairDenyRequestBody;
  try {
    body = (await request.json()) as PairDenyRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body.userCode !== "string" || body.userCode.length === 0) {
    return NextResponse.json({ error: "userCode is required" }, { status: 400 });
  }

  await denyPairingRequest(body.userCode);

  return NextResponse.json({ ok: true });
}
