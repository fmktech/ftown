import type { NextAuthConfig, Session, User } from "next-auth";
import type { JWT } from "next-auth/jwt";

// Edge-safe: no ledger store, db or node:crypto may be imported here (the middleware bundles this file).

/** 12 h. Kept equal to LEDGER_SESSION_MAX_AGE_SECONDS in ledger-auth.ts (asserted in auth.test.ts). */
export const SESSION_MAX_AGE_SECONDS = 43200;

const ACCOUNT_ID = /^[A-Za-z0-9_-]{43}$/;

/**
 * Carry the account id and the signing device's endpoint id from the authorized user into the session JWT.
 * An existing token without a valid accountId and endpointId (a pre-ledger cookie) is invalidated by returning null.
 */
export function ledgerJwtCallback({ token, user }: { token: JWT; user?: User }): JWT | null {
  if (user) {
    token.id = user.id;
    token.endpointId = user.endpointId;
    return token;
  }
  if (typeof token.id !== "string" || !ACCOUNT_ID.test(token.id)) return null;
  if (typeof token.endpointId !== "string" || token.endpointId.length === 0) return null;
  return token;
}

/** Session user is exactly {id, endpointId}: NextAuth's default name/email/image are stripped. */
export function ledgerSessionCallback({ session, token }: { session: Session; token: JWT }): Session {
  session.user = { id: token.id as string, endpointId: token.endpointId as string } as Session["user"];
  return session;
}

export const authConfig = {
  providers: [],
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
  pages: { signIn: "/login" },
  callbacks: {
    jwt: ledgerJwtCallback,
    session: ledgerSessionCallback,
    // The middleware only checks that a session exists; real authorization is requireAccount().
    authorized: ({ auth }) => !!auth?.user,
  },
} satisfies NextAuthConfig;
