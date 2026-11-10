import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth.config";

// Edge-safe: only checks that a session cookie exists. Real authorization is requireAccount() on the server.
export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  matcher: ["/dashboard/:path*"],
};
