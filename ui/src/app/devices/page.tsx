import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { DevicesClient } from "./DevicesClient";

export default async function DevicesPage() {
  const session = await auth();

  if (!session?.user?.email) {
    redirect("/login");
  }

  return <DevicesClient />;
}
