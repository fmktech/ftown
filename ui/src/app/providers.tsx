"use client";

import { usePathname } from "next/navigation";
import { SessionProvider } from "next-auth/react";
import { AuthModeProvider } from "@/lib/auth-mode";

/**
 * Inlined at build time: NEXT_PUBLIC_SOLO=1 builds run behind
 * `ftown-bridge --solo`, which authenticates with a Bearer access key and no
 * cookies (contract S8) — so the NextAuth SessionProvider is never mounted.
 */
const SOLO_MODE = process.env.NEXT_PUBLIC_SOLO === "1";

export function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (!SOLO_MODE && pathname === "/local") return <>{children}</>;
  if (SOLO_MODE) {
    return <AuthModeProvider mode="solo">{children}</AuthModeProvider>;
  }
  return (
    <SessionProvider>
      <AuthModeProvider mode="hosted">{children}</AuthModeProvider>
    </SessionProvider>
  );
}
