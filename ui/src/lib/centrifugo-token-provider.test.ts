import { describe, expect, it, vi } from "vitest";
import { createCentrifugoTokenProvider } from "./centrifugo-token-provider";

const NOW = 1_000_000;
const jwt = (expMs: number) => `header.${btoa(JSON.stringify({ exp: expMs / 1000 })).replace(/=/g, "")}.signature`;

describe("Centrifugo token provider", () => {
  it("reuses a token on reconnect with more than ten minutes left", async () => {
    const initial = jwt(NOW + 601_000);
    const mint = vi.fn();
    const getToken = createCentrifugoTokenProvider(initial, mint, () => NOW);
    expect(await getToken()).toBe(initial);
    expect(await getToken()).toBe(initial);
    expect(mint).not.toHaveBeenCalled();
  });

  it.each([600_000, 599_000])("renews at or within the margin (%i ms)", async remaining => {
    const renewed = jwt(NOW + 43_200_000);
    const mint = vi.fn().mockResolvedValue(renewed);
    const getToken = createCentrifugoTokenProvider(jwt(NOW + remaining), mint, () => NOW);
    expect(await getToken()).toBe(renewed);
    expect(await getToken()).toBe(renewed);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it.each(["", "invalid", "a.%%%.c", `a.${btoa('{}')}.c`, jwt(NOW - 1000)])("mints for an unusable token %s", async initial => {
    const mint = vi.fn().mockResolvedValue("renewed");
    expect(await createCentrifugoTokenProvider(initial, mint, () => NOW)()).toBe("renewed");
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("shares concurrent mint requests", async () => {
    let finish!: (token: string) => void;
    const mint = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const getToken = createCentrifugoTokenProvider("", mint, () => NOW);
    const first = getToken();
    const second = getToken();
    await Promise.resolve();
    expect(mint).toHaveBeenCalledTimes(1);
    finish("renewed");
    await expect(Promise.all([first, second])).resolves.toEqual(["renewed", "renewed"]);
  });

  it("propagates a mint failure and retries on the next call", async () => {
    const error = new Error("unauthorized");
    const mint = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("renewed");
    const getToken = createCentrifugoTokenProvider("", mint, () => NOW);
    await expect(getToken()).rejects.toBe(error);
    await expect(getToken()).resolves.toBe("renewed");
    expect(mint).toHaveBeenCalledTimes(2);
  });
});
