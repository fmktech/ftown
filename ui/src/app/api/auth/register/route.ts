import { NextResponse } from "next/server";
import { hash } from "bcryptjs";
import { getDb } from "@/lib/db";

interface RegisterBody {
  email: string;
  password: string;
}

interface DbUserRow {
  id: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as RegisterBody;
  const { email, password } = body;

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return NextResponse.json(
      { error: "Valid email is required" },
      { status: 400 }
    );
  }

  if (!password || typeof password !== "string" || password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 }
    );
  }

  const sql = getDb();

  const existing = (await sql.query(
    "SELECT id FROM users WHERE email = $1",
    [email]
  )) as DbUserRow[];

  if (existing.length > 0) {
    return NextResponse.json(
      { error: "Email already registered" },
      { status: 409 }
    );
  }

  const passwordHash = await hash(password, 12);

  await sql.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2)",
    [email, passwordHash]
  );

  return NextResponse.json(
    { message: "User created successfully" },
    { status: 201 }
  );
}
