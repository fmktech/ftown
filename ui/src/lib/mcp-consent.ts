import jwt from "jsonwebtoken";
import { getRequiredSecret } from "@/lib/secrets";

export function mcpOrigins() {
  const gateway = process.env.FTOWN_MCP_PUBLIC_URL;
  const login = process.env.FTOWN_PUBLIC_URL;
  for (const value of [gateway, login]) {
    if (
      !value ||
      new URL(value).protocol !== "https:" ||
      new URL(value).origin !== value
    )
      throw new Error("MCP HTTPS origins are not configured");
  }
  return { gateway: gateway!, login: login! };
}
export async function mcpConsentRequest<T>(
  subject: string,
  request: string,
  purpose: "inspect" | "approve" | "deny",
  machines?: string[],
): Promise<T> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(request)) throw new Error("Invalid request");
  const { gateway, login } = mcpOrigins();
  const assertion = jwt.sign(
    { request, purpose, ...(machines ? { machines } : {}) },
    getRequiredSecret("FTOWN_MCP_APPROVAL_SECRET"),
    {
      algorithm: "HS256",
      issuer: login,
      audience: gateway,
      subject,
      expiresIn: 60,
    },
  );
  const result = await fetch(
    `${gateway}/consent/${purpose === "inspect" ? "details" : purpose}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assertion }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!result.ok)
    throw new Error("Authorization request expired or unavailable");
  return result.json() as Promise<T>;
}
