import { afterEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import { mcpConsentRequest, mcpOrigins } from "./mcp-consent";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("MCP consent handoff", () => {
  it("requires fixed HTTPS origins and refuses credentials/path-bearing URLs", () => {
    vi.stubEnv("FTOWN_MCP_PUBLIC_URL", "http://mcp.example");
    vi.stubEnv("FTOWN_PUBLIC_URL", "https://ftown.example");
    expect(() => mcpOrigins()).toThrow();
    vi.stubEnv("FTOWN_MCP_PUBLIC_URL", "https://user:secret@mcp.example");
    expect(() => mcpOrigins()).toThrow();
  });
  it("sends a short-lived audience-bound assertion to the fixed server, never to a supplied URL", async () => {
    const secret = "test-only-key-with-more-than-thirty-two-characters";
    vi.stubEnv("FTOWN_MCP_PUBLIC_URL", "https://mcp.example");
    vi.stubEnv("FTOWN_PUBLIC_URL", "https://ftown.example");
    vi.stubEnv("FTOWN_MCP_APPROVAL_SECRET", secret);
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ redirect: "https://client.example/callback" }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    await mcpConsentRequest("account-id", "x".repeat(43), "approve", [
      "bridge-a",
    ]);
    expect(fetch.mock.calls[0][0]).toBe("https://mcp.example/consent/approve");
    const init = fetch.mock.calls[0][1];
    expect(init.redirect).toBe("error");
    const claims = jwt.verify(JSON.parse(init.body).assertion, secret, {
      algorithms: ["HS256"],
      issuer: "https://ftown.example",
      audience: "https://mcp.example",
    }) as jwt.JwtPayload;
    expect(claims.sub).toBe("account-id");
    expect(claims.purpose).toBe("approve");
    expect(claims.machines).toEqual(["bridge-a"]);
    expect(claims.exp! - claims.iat!).toBe(60);
    await expect(
      mcpConsentRequest("account-id", "https://attacker.example", "approve"),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
