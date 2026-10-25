import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { PairClient } from "./PairClient";

export default async function PairPage() {
  const session = await auth();


  return (
    <Suspense fallback={null}>
      <PairClient userEmail={session?.user?.email ?? null} ownerId={session?.user?.id ?? null} />
    </Suspense>
  );
}
