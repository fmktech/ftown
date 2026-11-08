// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { SecureEndpointRuntime } from "@/lib/secure-endpoint-runtime";

const mocks = vi.hoisted(() => ({ created: [] as unknown[], wrapped: [] as { raw: unknown }[] }));
vi.mock("centrifuge", () => ({
  UnauthorizedError: class extends Error {},
  Centrifuge: class {
    constructor() { mocks.created.push(this); }
    on() { return this; } off() { return this; } connect() {} disconnect() {}
    newSubscription() { return { on() {}, off() {}, subscribe() {}, unsubscribe() {} }; }
    getSubscription() { return null; }
  },
}));
vi.mock("@/lib/secure-message-client", () => ({
  SecureMessageClient: class { constructor(public raw: unknown) { mocks.wrapped.push(this as { raw: unknown }); } dispose() {} publish() { return Promise.resolve(); } getSubscription() { return null; } newSubscription() { return { on() {}, off() {}, subscribe() {} }; } },
}));
vi.mock("@/lib/direct-transport/hybrid-terminal-transport", () => ({ HybridTerminalTransport: class { dispose() {} } }));
import { useCentrifugo } from "./useCentrifugo";

const runtime = {} as SecureEndpointRuntime;
const jwt = `a.${btoa(JSON.stringify({ exp: 4102444800 }))}.c`;
beforeEach(() => { mocks.created.length = 0; mocks.wrapped.length = 0; });

it("rawClient is the instance backing client and is null exactly when client is", () => {
  const { result, rerender } = renderHook((p: { token: string | null }) => useCentrifugo(p.token, "wss://c.test", "u@test", { securityRuntime: runtime }), { initialProps: { token: jwt as string | null } });
  expect(result.current.client).toBe(mocks.wrapped[0]);
  expect(result.current.rawClient).not.toBeNull();
  expect(result.current.rawClient).toBe(mocks.created[0]);
  expect(result.current.rawClient).toBe(mocks.wrapped[0]!.raw);
  rerender({ token: null });
  expect(result.current.client).toBeNull();
  expect(result.current.rawClient).toBeNull();
});

it("rawClient changes identity when a new client is created", () => {
  const { result, rerender } = renderHook((p: { url: string }) => useCentrifugo(jwt, p.url, "u@test", { securityRuntime: runtime }), { initialProps: { url: "wss://a.test" } });
  const first = result.current.rawClient;
  expect(first).toBe(mocks.created[0]);
  rerender({ url: "wss://b.test" });
  expect(mocks.created).toHaveLength(2);
  expect(result.current.rawClient).toBe(mocks.created[1]);
  expect(result.current.rawClient).not.toBe(first);
  expect(result.current.rawClient).toBe(mocks.wrapped[1]!.raw);
});
