import { after, NextResponse } from "next/server";
import { hash } from "bcryptjs";
import { getDb } from "@/lib/db";
import { consumeRateLimit, REGISTER_RATE_LIMIT } from "@/lib/login-rate-limit";
import { boundedSecurityJson, SecurityStoreError } from "@/lib/security-store";
import { clientIp } from "@/lib/client-ip";
import { isRegistrationEnabled } from "@/lib/registration";
import { notifyCustomerSignup } from "@/lib/signup-webhook";

interface RegisterBody {
  email: string;
  password: string;
}

interface DbUserRow {
  id: string;
}

const REGISTER_SCOPE = "register-admission";

/**
 * Generic, non-enumerating response (F4). Returned identically whether or not
 * the email already exists so an attacker cannot probe for registered accounts.
 */
function acceptedResponse(): NextResponse {
  return NextResponse.json(
    { message: "If the details are valid, your account has been created. You can now sign in." },
    { status: 200 }
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!isRegistrationEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rateLimit = await consumeRateLimit(REGISTER_SCOPE, clientIp(request), REGISTER_RATE_LIMIT);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many registration attempts. Try again later." },
      { status: 429 }
    );
  }

  let body: RegisterBody;
  try {
    const raw = await boundedSecurityJson(request, 16_384);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Invalid body");
    body = raw as RegisterBody;
  } catch (error) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: error instanceof SecurityStoreError ? error.status : 400 });
  }

  const { email, password } = body;

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return NextResponse.json(
      { error: "Valid email is required" },
      { status: 400 }
    );
  }

  // Cap length: bcrypt cost is CPU-heavy, so unbounded passwords allow cheap
  // request-bodies to burn server CPU (long strings before the 72-byte bcrypt
  // cutoff still cost hashing time).
  if (
    !password ||
    typeof password !== "string" ||
    password.length < 8 ||
    password.length > 1024
  ) {
    return NextResponse.json(
      { error: "Password must be between 8 and 1024 characters" },
      { status: 400 }
    );
  }

  const sql = getDb();

  const existing = (await sql.query(
    "SELECT id FROM users WHERE email = $1",
    [email]
  )) as DbUserRow[];

  // F4: never leak existence. Silently no-op on an already-registered email and
  // return the same generic response as a fresh registration.
  if (existing.length > 0) {
    return acceptedResponse();
  }

  const passwordHash = await hash(password, 12);

  const created = (await sql.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id",
    [email, passwordHash]
  )) as DbUserRow[];

  if (created.length > 0) {
    after(() => notifyCustomerSignup(email));
  }

  return acceptedResponse();
}
