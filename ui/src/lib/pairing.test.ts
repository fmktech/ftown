import { describe, expect, it } from "vitest";
import { genDeviceCode, genUserCode } from "./pairing";

describe("genUserCode", () => {
  it("matches the XXXX-XXXX unambiguous-alphabet format", () => {
    for (let i = 0; i < 200; i++) {
      expect(genUserCode()).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    }
  });

  it("never contains ambiguous characters I, L, O, U", () => {
    for (let i = 0; i < 200; i++) {
      expect(genUserCode()).not.toMatch(/[ILOU]/);
    }
  });
});

describe("genDeviceCode", () => {
  it("produces a base64url string decoding to 32 bytes", () => {
    const code = genDeviceCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(code, "base64url").length).toBe(32);
  });

  it("is unique across calls", () => {
    const codes = new Set(Array.from({ length: 200 }, () => genDeviceCode()));
    expect(codes.size).toBe(200);
  });
});
