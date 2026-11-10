import type { Page } from "@playwright/test";
import { getCentrifugoToken } from "./app";
import { attemptPublish } from "./centrifugo-raw";
import { serverLedger } from "./ledger-admin";

/**
 * Make the dashboard re-read the account ledger (its "trust refresh"): publish a
 * `ledger_head` notice on bridges:ledger#<accountId> — the shape the server
 * publishes when a ledger change is too large to push — naming a head the
 * browser does not hold, so it fetches GET /api/account/ledger. The fetched
 * ledger is the server's verified copy; the notice itself carries no authority.
 * The announced revision is one past the server's, because browsers ignore
 * notices that are not ahead of their own chain.
 * Uses a relay token minted from the page's own session (POST /api/auth/token)
 * and the raw Centrifugo client. Throws if Centrifugo rejects the publish.
 */
export async function publishLedgerHeadNotice(page: Page, accountId: string): Promise<void> {
  const token = await getCentrifugoToken(page);
  const head = "A".repeat(43);
  const revision = (await serverLedger()).checkpoint.revision + 1;
  const result = await attemptPublish(token, `bridges:ledger#${accountId}`, { type: "ledger_head", head, revision });
  if (!result.ok) throw new Error(`ledger_head publish rejected: ${result.error?.code} ${result.error?.message}`);
}
