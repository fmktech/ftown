import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { revokeDevice } from "@/lib/bridge-refresh";

export const runtime = "nodejs";

interface RevokeBody {
  bridgeId: string;
}

function parseBody(value: unknown): RevokeBody | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const bridgeId = (value as Record<string, unknown>).bridgeId;
  if (typeof bridgeId !== "string" || bridgeId.length === 0) {
    return null;
  }
  return { bridgeId };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "bridgeId required" }, { status: 400 });
  }

  const body = parseBody(raw);
  if (!body) {
    return NextResponse.json({ error: "bridgeId required" }, { status: 400 });
  }

  const ok = await revokeDevice(email, body.bridgeId);
  if (!ok) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
