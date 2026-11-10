// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const signInMock = vi.fn();
vi.mock("next-auth/react", () => ({ signIn: (...args: unknown[]) => signInMock(...args) }));

import { buildLedgerDeps, getLedgerClient, ledgerRuntimeConfig, resetLedgerClientForTests } from "./ledger-runtime";

beforeEach(() => {
  resetLedgerClientForTests(); signInMock.mockReset();
  // Isolate from CI/e2e job env (which exports these for the whole job).
  vi.stubEnv("NEXT_PUBLIC_FTOWN_PUBLIC_URL", "");
  vi.stubEnv("NEXT_PUBLIC_FTOWN_RP_ID", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("dev: unset public URL falls back to the page origin and is configured", () => {
  vi.stubEnv("NODE_ENV", "development");
  expect(ledgerRuntimeConfig()).toEqual({ origin: window.location.origin, publicOrigin: window.location.origin, rpId: window.location.hostname, configured: true });
});

it("production: unset public URL is unconfigured and creation is refused via publicOrigin ''", () => {
  vi.stubEnv("NODE_ENV", "production");
  expect(ledgerRuntimeConfig()).toMatchObject({ publicOrigin: null, configured: false });
  expect(buildLedgerDeps().publicOrigin).toBe("");
});

it("production: non-canonical public URL is unconfigured", () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_FTOWN_PUBLIC_URL", "https://app.example.test/path");
  expect(ledgerRuntimeConfig()).toMatchObject({ publicOrigin: null, configured: false });
});

it("configured: public origin and rpId derive from the public URL, RP id env overrides", () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_FTOWN_PUBLIC_URL", "https://app.example.test");
  expect(ledgerRuntimeConfig()).toEqual({ origin: window.location.origin, publicOrigin: "https://app.example.test", rpId: "app.example.test", configured: true });
  expect(buildLedgerDeps().publicOrigin).toBe("https://app.example.test");
  vi.stubEnv("NEXT_PUBLIC_FTOWN_RP_ID", "example.test");
  expect(ledgerRuntimeConfig().rpId).toBe("example.test");
});

it("returns one client per page", () => {
  const first = getLedgerClient();
  expect(getLedgerClient()).toBe(first);
  expect(typeof first.load).toBe("function");
});

it("throws a clear error on the server", () => {
  vi.stubGlobal("window", undefined);
  expect(() => getLedgerClient()).toThrow("ledger_client_browser_only");
  expect(() => ledgerRuntimeConfig()).toThrow("ledger_client_browser_only");
});

it("maps next-auth results to a boolean and uses sessionStorage for attempts", async () => {
  const deps = buildLedgerDeps();
  expect(deps.attemptStorage).toBe(window.sessionStorage);
  signInMock.mockResolvedValueOnce({ ok: true, error: undefined });
  expect(await deps.signIn("{\"p\":1}")).toBe(true);
  expect(signInMock).toHaveBeenCalledWith("ledger", { proof: "{\"p\":1}", redirect: false });
  signInMock.mockResolvedValueOnce({ ok: false, error: "CredentialsSignin" });
  expect(await deps.signIn("x")).toBe(false);
  signInMock.mockResolvedValueOnce(undefined);
  expect(await deps.signIn("x")).toBe(false);
});
