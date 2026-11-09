import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDevicesForSub } from "@/lib/bridge-refresh";
import { accountBridgeIds } from "@/lib/bridge-revocation";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const session = await auth();
  const email = session?.user?.email;
  const userId = session?.user?.id;
  if (!email || !userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let ids: Set<string>;
  try {
    ids = await accountBridgeIds(userId);
  } catch (error) {
    console.error("[bridges/devices] account roster unavailable", error);
    return NextResponse.json({ error: "account_unavailable" }, { status: 503 });
  }

  const devices = await getDevicesForSub(email);
  return NextResponse.json({
    devices: devices.map(device => ({ ...device, accountMember: ids.has(device.bridgeId) })),
  });
}
