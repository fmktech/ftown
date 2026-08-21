import { NextResponse } from "next/server";
import { hash } from "bcryptjs";
import { getDb } from "@/lib/db";
import {
  checkRateLimit,
  recordAttempt,
  REGISTER_RATE_LIMIT,
} from "@/lib/login-rate-limit";
import { clientIp } from "@/lib/client-ip";
import { isRegistrationEnabled } from "@/lib/registration";

interface RegisterBody {
  email: string;
  password: string;
}

interface DbUserRow {
  id: string;
}

const REGISTER_SCOPE = "register";

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

  let body: RegisterBody;
  try {
    body = (await request.json()) as RegisterBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
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

  // F4: throttle registration abuse per client IP.
  const ip = clientIp(request);
  const rateLimit = await checkRateLimit(REGISTER_SCOPE, ip);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many registration attempts. Try again later." },
      { status: 429 }
    );
  }
  await recordAttempt(REGISTER_SCOPE, ip, REGISTER_RATE_LIMIT);

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

  await sql.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING",
    [email, passwordHash]
  );

  return acceptedResponse();
}
