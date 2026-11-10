import { redirect } from "next/navigation";
import { requireAccount } from "@/lib/ledger-auth";
import { signRelayToken } from "@/lib/relay-jwt";
import { DashboardClient } from "@/components/DashboardClient";

export default async function DashboardPage() {
  let accountId: string;
  try {
    ({ accountId } = await requireAccount());
  } catch (err) {
    if ((err as { status?: number } | null)?.status === 401) redirect("/login");
    throw err;
  }

  const centrifugoUrl = process.env.NEXT_PUBLIC_CENTRIFUGO_URL;
  if (!centrifugoUrl) {
    throw new Error("Missing NEXT_PUBLIC_CENTRIFUGO_URL environment variable");
  }

  const { token } = signRelayToken({ accountId });

  return (
    <DashboardClient
      ownerId={accountId}
      userId={accountId}
      token={token}
      centrifugoUrl={centrifugoUrl}
    />
  );
}
