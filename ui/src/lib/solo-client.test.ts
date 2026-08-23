import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SOLO_KEY_STORAGE,
  SoloAuthError,
  bootstrap,
  captureKeyFromHash,
  clearKey,
  getHealth,
  getStoredKey,
  mintToken,
  storeKey,
} from "./solo-client";

const TEST_KEY = "a".repeat(64);

interface FetchLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<FetchLike>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(handler);
  vi.stubGlobal("fetch", mock as unknown as typeof fetch);
  return mock;
}

function stubWindow(hash: string): {
  storage: Map<string, string>;
  replaceState: ReturnType<typeof vi.fn>;
} {
  const storage = new Map<string, string>();
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
    history: { replaceState },
    location: { hash, pathname: "/local", search: "" },
  });
  return { storage, replaceState };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("captureKeyFromHash", () => {
  it("stores a #k= key and clears the fragment without reloading", () => {
    const { storage, replaceState } = stubWindow(`#k=${TEST_KEY}`);

    expect(captureKeyFromHash()).toBe(TEST_KEY);
    expect(storage.get(SOLO_KEY_STORAGE)).toBe(TEST_KEY);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/local");
  });

  it("lowercases the stored key", () => {
    const { storage } = stubWindow(`#k=${TEST_KEY.toUpperCase()}`);

    expect(captureKeyFromHash()).toBe(TEST_KEY);
    expect(storage.get(SOLO_KEY_STORAGE)).toBe(TEST_KEY);
  });

  it("ignores unrelated hashes entirely", () => {
    const { storage, replaceState } = stubWindow("#section-2");

    expect(captureKeyFromHash()).toBeNull();
    expect(storage.size).toBe(0);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("rejects malformed keys and leaves the hash untouched", () => {
    const { storage, replaceState } = stubWindow("#k=not-hex");

    expect(captureKeyFromHash()).toBeNull();
    expect(storage.size).toBe(0);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("rejects keys with the wrong length", () => {
    const { storage } = stubWindow("#k=abcd");

    expect(captureKeyFromHash()).toBeNull();
    expect(storage.size).toBe(0);
  });
});

describe("stored key helpers", () => {
  it("round-trips the key through localStorage", () => {
    stubWindow("");

    expect(getStoredKey()).toBeNull();
    storeKey(TEST_KEY);
    expect(getStoredKey()).toBe(TEST_KEY);
    clearKey();
    expect(getStoredKey()).toBeNull();
  });
});

describe("bootstrap", () => {
  it("sends the bearer key, forwards the signal, and parses the payload", async () => {
    stubWindow("");
    const controller = new AbortController();
    const payload = { userId: "solo", centrifugoUrl: "ws://10.0.0.5:8040/hub/connection/websocket", token: "jwt" };
    const fetchMock = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
    }));

    await expect(bootstrap(TEST_KEY, controller.signal)).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/solo/bootstrap",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: `Bearer ${TEST_KEY}` },
        signal: controller.signal,
      })
    );
  });

  it("maps 401 to SoloAuthError", async () => {
    stubWindow("");
    stubFetch(async () => ({ ok: false, status: 401, json: async () => ({ error: "bad key" }) }));

    await expect(bootstrap(TEST_KEY)).rejects.toBeInstanceOf(SoloAuthError);
  });

  it("wraps other non-OK statuses in a plain error", async () => {
    stubWindow("");
    stubFetch(async () => ({ ok: false, status: 502, json: async () => ({}) }));

    await expect(bootstrap(TEST_KEY)).rejects.toThrow("Solo bootstrap failed (502)");
  });

  it("surfaces network failures verbatim for the starting screen", async () => {
    stubWindow("");
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(bootstrap(TEST_KEY)).rejects.toThrow(TypeError);
  });
});

describe("mintToken", () => {
  it("POSTs the bearer key and returns token + expiry", async () => {
    stubWindow("");
    const payload = { token: "fresh-jwt", expiresAt: "2026-08-23T12:00:00.000Z" };
    const fetchMock = stubFetch(async () => ({ ok: true, status: 200, json: async () => payload }));

    await expect(mintToken(TEST_KEY)).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/solo/token",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: `Bearer ${TEST_KEY}` },
      })
    );
  });

  it("maps 401 to SoloAuthError", async () => {
    stubWindow("");
    stubFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));

    await expect(mintToken(TEST_KEY)).rejects.toBeInstanceOf(SoloAuthError);
  });
});

describe("getHealth", () => {
  it("parses child liveness without sending any auth header", async () => {
    stubWindow("");
    const fetchMock = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, hub: "up", panel: "down" }),
    }));

    await expect(getHealth()).resolves.toEqual({ ok: true, hub: "up", panel: "down" });
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.headers).toBeUndefined();
  });

  it("throws on non-OK responses", async () => {
    stubWindow("");
    stubFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));

    await expect(getHealth()).rejects.toThrow("healthz failed (500)");
  });
});
