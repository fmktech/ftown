import { Suspense } from "react";
import { requireAccount } from "@/lib/ledger-auth";
import { PairClient } from "./PairClient";

/** The server only learns whether a session exists. The link fragment never reaches it. */
export default async function PairPage() {
  let signedIn = false;
  try {
    await requireAccount();
    signedIn = true;
  } catch {
    signedIn = false;
  }
  return (
    <Suspense fallback={null}>
      <PairClient signedIn={signedIn} />
    </Suspense>
  );
}
