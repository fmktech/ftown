import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { auth } from "@/lib/auth";
import { approvePairingRequest } from "@/lib/pairing-store";

export const runtime = "nodejs";

interface PairApproveRequestBody {
  userCode: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: PairApproveRequestBody;
  try {
    body = (await request.json()) as PairApproveRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body.userCode !== "string" || body.userCode.length === 0) {
    return NextResponse.json({ error: "userCode is required" }, { status: 400 });
  }

  const refreshJti = randomUUID();
  const approved = await approvePairingRequest(body.userCode, email, refreshJti);
  if (!approved) {
    return NextResponse.json(
      { error: "Code not found, expired, or already handled." },
      { status: 400 }
    );
  }

  return NextResponse.json({ ok: true });
}
