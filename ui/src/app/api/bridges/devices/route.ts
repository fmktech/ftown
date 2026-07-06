import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDevicesForSub } from "@/lib/bridge-refresh";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const devices = await getDevicesForSub(email);
  return NextResponse.json({ devices });
}
