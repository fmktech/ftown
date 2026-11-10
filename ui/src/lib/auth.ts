import NextAuth from "next-auth";
import { getRequiredSecret } from "@/lib/secrets";
import { ledgerCredentialsProvider } from "@/lib/ledger-auth";
import { authConfig } from "@/lib/auth.config";

export { ledgerJwtCallback, ledgerSessionCallback } from "@/lib/auth.config";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  // Fail fast if AUTH_SECRET is missing or weak: never run sessions on a weak/absent signing key.
  secret: getRequiredSecret("AUTH_SECRET"),
  providers: [ledgerCredentialsProvider()],
});
