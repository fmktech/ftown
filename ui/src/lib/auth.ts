import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { getDb } from "@/lib/db";
import { checkLoginRateLimit, recordFailedLogin, resetLoginAttempts } from "@/lib/login-rate-limit";

interface DbUser {
  id: string;
  email: string;
  password_hash: string;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email;
        const password = credentials?.password;

        if (typeof email !== "string" || typeof password !== "string") {
          return null;
        }

        const rateLimit = await checkLoginRateLimit(email);
        if (!rateLimit.allowed) {
          throw new Error("Too many failed attempts. Try again later.");
        }

        const sql = getDb();
        const rows = (await sql.query(
          "SELECT id, email, password_hash FROM users WHERE email = $1",
          [email]
        )) as DbUser[];

        if (rows.length === 0) {
          await recordFailedLogin(email);
          return null;
        }

        const user = rows[0];
        const isValid = await compare(password, user.password_hash);

        if (!isValid) {
          await recordFailedLogin(email);
          return null;
        }

        await resetLoginAttempts(email);
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
