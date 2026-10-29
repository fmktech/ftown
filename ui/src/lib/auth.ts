import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { getDb } from "@/lib/db";
import { consumeRateLimit, LOGIN_IP_RATE_LIMIT } from "@/lib/login-rate-limit";
import { clientIp } from "@/lib/client-ip";
import { getRequiredSecret } from "@/lib/secrets";

interface DbUser {
  id: string;
  email: string;
  password_hash: string;
}

// Precomputed cost-12 hash of an unknown value. Compared against whenever the
// email does not exist so the response time matches the found-user path and
// login cannot be used to enumerate registered accounts by timing.
const DUMMY_BCRYPT_HASH = "$2b$12$bEukDr9TKCHPZqKVWUmg8eqZhrVeYoL3B7xeNx3PHdzD2XK6kAqSm";

export const { handlers, auth, signIn, signOut } = NextAuth({
  // F2: fail-fast if AUTH_SECRET is missing or weak — never run sessions on a
  // weak/absent signing key.
  secret: getRequiredSecret("AUTH_SECRET"),
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        const email = credentials?.email;
        const password = credentials?.password;

        if (typeof email !== "string" || typeof password !== "string" || password.length > 1024) {
          return null;
        }

        const rateLimit = await consumeRateLimit("login-ip-admission", clientIp(request), LOGIN_IP_RATE_LIMIT);
        if (!rateLimit.allowed) {
          throw new Error("Too many failed attempts. Try again later.");
        }

        const sql = getDb();
        const rows = (await sql.query(
          "SELECT id, email, password_hash FROM users WHERE email = $1",
          [email]
        )) as DbUser[];

        if (rows.length === 0) {
          await compare(password, DUMMY_BCRYPT_HASH);
          return null;
        }

        const user = rows[0];
        const isValid = await compare(password, user.password_hash);

        if (!isValid) {
          return null;
        }

        return { id: user.id, email: user.email };
      },
    }),
  ],
  session: {
    strategy: "jwt",
  },
  pages: {
    signIn: "/login",
  },
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.email = user.email;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.email = token.email as string;
      }
      return session;
    },
  },
});
