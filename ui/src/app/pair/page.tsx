import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { PairClient } from "./PairClient";

export default async function PairPage() {
  const session = await auth();

  if (!session?.user?.email) {
    redirect("/login");
  }

  return (
    <Suspense fallback={null}>
      <PairClient userEmail={session.user.email} />
    </Suspense>
  );
}
