import { expect, it, vi } from "vitest";

const { config } = vi.hoisted(() => ({ config: { current: undefined as undefined | Record<string, unknown> } }));
vi.mock("next-auth", () => ({ default: (c: Record<string, unknown>) => {
  config.current = c;
  return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
} }));
vi.mock("@/lib/secrets", () => ({ getRequiredSecret: () => "secret" }));
vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
import { ledgerJwtCallback, ledgerSessionCallback } from "./auth";
import { SESSION_MAX_AGE_SECONDS } from "./auth.config";
import { LEDGER_SESSION_MAX_AGE_SECONDS } from "./ledger-auth";

const ACCOUNT = "A".repeat(43);
const UUID = "123e4567-e89b-12d3-a456-426614174000";

it("configures only the ledger provider, jwt sessions at the real ledger lifetime and the /login page", () => {
  expect(SESSION_MAX_AGE_SECONDS).toBe(LEDGER_SESSION_MAX_AGE_SECONDS);
  const providers = config.current?.providers as Array<{ id?: string; options?: { id?: string } }>;
  expect(providers).toHaveLength(1);
  expect(providers[0].options?.id).toBe("ledger");
  expect(config.current?.session).toEqual({ strategy: "jwt", maxAge: LEDGER_SESSION_MAX_AGE_SECONDS });
  expect(config.current?.pages).toEqual({ signIn: "/login" });
});

it("round-trips accountId and endpointId, and strips NextAuth's default name/email/image", () => {
  const token = ledgerJwtCallback({ token: {} as never, user: { id: ACCOUNT, endpointId: "ep" } as never })!;
  expect(token).toMatchObject({ id: ACCOUNT, endpointId: "ep" });
  const session = ledgerSessionCallback({
    session: { user: { name: "n", email: "e@x.y", image: "i" }, expires: "x" } as never, token,
  });
  expect(session.user).toEqual({ id: ACCOUNT, endpointId: "ep" });
});

it("keeps a valid existing token on refresh", () => {
  const token = { id: ACCOUNT, endpointId: "ep" } as never;
  expect(ledgerJwtCallback({ token })).toBe(token);
});

it("invalidates a v1 cookie: UUID id, missing id, or missing endpointId", () => {
  expect(ledgerJwtCallback({ token: { id: UUID, endpointId: "ep", email: "a@b.c" } as never })).toBeNull();
  expect(ledgerJwtCallback({ token: { endpointId: "ep" } as never })).toBeNull();
  expect(ledgerJwtCallback({ token: { id: ACCOUNT } as never })).toBeNull();
  expect(ledgerJwtCallback({ token: { id: ACCOUNT, endpointId: "" } as never })).toBeNull();
});
