import { test, expect } from "@playwright/test";
import { bridgeApiFetch } from "../helpers/bridge-api";

/** Durable mail regression coverage through the bridge loopback API. */

interface WireSessionLite {
  id: string;
}
interface MailMessageLite {
  id: string;
  from: string;
  fromName?: string;
  body: string;
  to: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================ MAIL ============================

async function createShellSessionApi(name: string): Promise<string> {
  const res = await bridgeApiFetch("POST", "/api/sessions", {
    body: { shellType: "shell", name },
  });
  expect(res.status, "POST /api/sessions must create a shell session").toBe(201);
  return (res.body as { session: WireSessionLite }).session.id;
}

async function deleteSessionQuietly(id: string | undefined): Promise<void> {
  if (!id) return;
  try {
    await bridgeApiFetch("DELETE", `/api/sessions/${id}`);
  } catch {
    // best-effort
  }
}

async function postMail(
  sessionId: string,
  mail: { body: string; from: string; fromName?: string },
): Promise<void> {
  const res = await bridgeApiFetch("POST", `/api/sessions/${sessionId}/inbox`, { body: mail });
  expect(res.status, "POST inbox must accept the message").toBe(201);
  expect((res.body as { id: string }).id, "accepted mail returns an id").toBeTruthy();
}

test.describe("mail delivery service", () => {
  test("inbox deliver + read: message is stored with sender and text", async () => {
    let sessionId: string | undefined;
    try {
      sessionId = await createShellSessionApi(`e2e-mail-${Date.now()}`);
      const body = `hello-mail-${Date.now()}`;

      await postMail(sessionId, { body, from: "e2e-sender", fromName: "E2E Sender" });

      // peek=1&all=1 reads the full inbox without marking anything delivered.
      const read = await bridgeApiFetch("GET", `/api/sessions/${sessionId}/inbox?peek=1&all=1`);
      expect(read.status, "GET inbox must succeed").toBe(200);
      const messages = (read.body as { messages: MailMessageLite[] }).messages;

      const found = messages.find((m) => m.body === body);
      expect(found, "posted message must be present in the inbox").toBeTruthy();
      expect(found?.from, "sender is preserved").toBe("e2e-sender");
      expect(found?.fromName, "friendly sender name is preserved").toBe("E2E Sender");
      expect(found?.to, "recipient is the session id").toBe(sessionId);
    } finally {
      await deleteSessionQuietly(sessionId);
    }
  });

  test("long-poll delivery: an open poll resolves when mail arrives", async () => {
    let sessionId: string | undefined;
    try {
      sessionId = await createShellSessionApi(`e2e-poll-${Date.now()}`);
      const sid = sessionId;

      // A session only earns the long-poll listen window if it "participates in
      // mail" (parent/children/orchestrator/prior history). Prime that history:
      // post one message and drain it, so the subsequent poll actually HOLDS
      // instead of returning immediately with effectiveWait=0.
      await postMail(sid, { body: "prime", from: "e2e-primer" });
      const drain = await bridgeApiFetch("GET", `/api/sessions/${sid}/inbox`); // wait=0 -> drain
      expect(drain.status).toBe(200);

      const payload = `poll-mail-${Date.now()}`;

      // Open the long poll (wait=5s, well under the 30s server cap) on the now-empty
      // inbox, then post while it is held. Promise.all overlaps the two; the small
      // delay makes it overwhelmingly likely the waiter is registered first, which
      // is the path being proven.
      const [pollRes] = await Promise.all([
        bridgeApiFetch("GET", `/api/sessions/${sid}/inbox?wait=5`),
        (async () => {
          await sleep(750);
          await postMail(sid, { body: payload, from: "e2e-waker" });
        })(),
      ]);

      expect(pollRes.status, "long poll must resolve 200").toBe(200);
      const messages = (pollRes.body as { messages: MailMessageLite[] }).messages;
      const found = messages.find((m) => m.body === payload);
      expect(found, "long poll must resolve with the message posted while it was open").toBeTruthy();
      expect(found?.from).toBe("e2e-waker");
    } finally {
      await deleteSessionQuietly(sessionId);
    }
  });

  // (5) nudge/injection — SKIPPED. The idle nudge IS loopback-observable (it
  // runner.write()s a one-line pointer into the session PTY, visible via
  // /api/sessions/:id/screen), but it fires only after MAIL_NUDGE_DELAY_MS (5s)
  // AND the long single-line pointer is subject to xterm/PTY line-wrapping, so a
  // substring assertion on the rendered screen is genuinely flaky. Per the task's
  // "SKIP rather than a flaky check" guidance, we do not assert it here.
  test.skip("nudge injects a mail pointer into the session PTY", async () => {
    // Intentionally empty: see the comment above for why this is skipped.
  });
});
