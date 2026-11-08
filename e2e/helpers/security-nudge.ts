import type { Page } from "@playwright/test";
import { getCentrifugoToken } from "./app";
import { attemptPublish } from "./centrifugo-raw";

/**
 * Publish an owner security nudge ({"type":"ftown_security_changed","version":1,
 * "scope":"account"|"approvals"}) on bridges:security#<email>, exactly what the
 * dashboard listens for. Uses an owner token minted from the page's own session
 * (POST /api/auth/token) and the raw Centrifugo client (the e2e package has no
 * `centrifuge` dependency). Throws if Centrifugo rejects the publish.
 */
export async function publishSecurityNudge(page: Page, email: string, scope: "account" | "approvals" = "account"): Promise<void> {
  const token = await getCentrifugoToken(page);
  const result = await attemptPublish(token, `bridges:security#${email}`, { type: "ftown_security_changed", version: 1, scope });
  if (!result.ok) throw new Error(`security nudge publish rejected: ${result.error?.code} ${result.error?.message}`);
}
