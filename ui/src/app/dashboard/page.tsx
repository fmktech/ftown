import { redirect } from "next/navigation";
import jwt from "jsonwebtoken";
import { auth } from "@/lib/auth";
import { DashboardClient } from "@/components/DashboardClient";

export default async function DashboardPage() {
  const session = await auth();

  if (!session?.user?.email) {
    redirect("/login");
  }

  const email = session.user.email;
  const centrifugoSecret = process.env.CENTRIFUGO_TOKEN_SECRET;
  const centrifugoUrl = process.env.NEXT_PUBLIC_CENTRIFUGO_URL;

  if (!centrifugoSecret || !centrifugoUrl) {
    throw new Error("Missing CENTRIFUGO_TOKEN_SECRET or NEXT_PUBLIC_CENTRIFUGO_URL environment variable");
  }

  const token = jwt.sign({ sub: email }, centrifugoSecret, { expiresIn: "24h" });

  return (
    <DashboardClient
      userId={email}
      token={token}
      centrifugoUrl={centrifugoUrl}
    />
  );
}
