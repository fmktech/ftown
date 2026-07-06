import { NextRequest, NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { getByUserCode } from "@/lib/pairing-store";

export const runtime = "nodejs";

interface PairLookupRequestBody {
  userCode: string;
}

const NOT_FOUND_RESPONSE = { error: "That code is invalid or expired." } as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: PairLookupRequestBody;
  try {
    body = (await request.json()) as PairLookupRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body.userCode !== "string" || body.userCode.length === 0) {
    return NextResponse.json({ error: "userCode is required" }, { status: 400 });
  }

  const row = await getByUserCode(body.userCode);
  if (!row || row.status !== "pending" || new Date(row.expiresAt).getTime() < Date.now()) {
    return NextResponse.json(NOT_FOUND_RESPONSE, { status: 404 });
  }

  return NextResponse.json({
    bridgeId: row.bridgeId,
    hostname: row.hostname,
    platform: row.platform,
    createdAt: row.createdAt,
  });
}
