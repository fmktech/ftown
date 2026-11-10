import { NextResponse } from "next/server";
import { requireAccount } from "@/lib/ledger-auth";
import { signRelayToken } from "@/lib/relay-jwt";

export const runtime = "nodejs";

async function mint(): Promise<NextResponse> {
  let accountId: string;
  try {
    ({ accountId } = await requireAccount());
  } catch (err) {
    if ((err as { status?: number } | null)?.status === 401) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[auth/token] session check failed:", err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }

  let minted: { token: string; expiresAt: number };
  try {
    minted = signRelayToken({ accountId });
  } catch (err) {
    console.error(
      "[auth/token] secret misconfiguration:",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  return NextResponse.json(
    {
      token: minted.token,
      centrifugoUrl: process.env.NEXT_PUBLIC_CENTRIFUGO_URL,
      accountId,
      expiresAt: minted.expiresAt,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const POST = mint;
