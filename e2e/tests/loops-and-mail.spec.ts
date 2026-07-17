import { test, expect, type Page } from "@playwright/test";
import { sharedEmail, login, waitForBridgeOnline } from "../helpers/app";
import { createLoopViaUi } from "../helpers/loops";
import { bridgeApiFetch } from "../helpers/bridge-api";

/**
 * E2E coverage for the two loopback surfaces that had none: the loop
 * scheduler/controller (bridge/src/loop-controller.ts + loop-scheduler.ts) and
 * the freshly-extracted MailDeliveryService (bridge/src/mail-delivery.ts).
 *
 * Everything here drives the bridge's loopback HTTP API directly via
 * `bridgeApiFetch` (127.0.0.1:<port>, bearer from the bridge.json pointer). The
 * one UI touch is `createLoopViaUi` — it exercises the LoopFormModal create path.
 *
 * Real route shapes used (bridge/src/local-api-server.ts):
 *  - GET    /api/loops                 -> 200 { loops: Loop[] }
 *  - POST   /api/loops                 -> 201 { loop: Loop }        (bridgeId forced by controller)
 *  - GET    /api/loops/:id             -> 200 { loop: Loop } | 404
 *  - PATCH  /api/loops/:id             -> 200 { loop: Loop }
 *  - DELETE /api/loops/:id             -> 200 { removed: boolean, loopId }
 *  - POST   /api/loops/:id/run-now     -> 200 { fired: true, loop } | { fired:false, reason }
 *  - GET    /api/loops/:id/runs        -> 200 { runs: LoopRunRecord[] }
 *  - POST   /api/sessions              -> 201 { session: WireSession }
 *  - POST   /api/sessions/:id/inbox    -> 201 { id }   (MailDeliveryService.acceptMail)
 *  - GET    /api/sessions/:id/inbox    -> 200 { messages: MailMessage[] }
 *           query: wait=<s> (long poll), peek=1, all=1, limit=<n>
 *
 * NOTE: the scheduler ticks every 30s (LOOP_TICK_INTERVAL_MS), so natural
 * interval accrual is slow; run-now (scheduler.kick -> immediate out-of-band
 * tick) is the timely driver for the mutation assertions.
 */

// ---- typed views of the JSON bodies we assert on (bodies come back as unknown) ----

interface LoopLite {
  id: string;
  name: string;
  enabled: boolean;
  runCount: number;
  skipCount: number;
  lastStatus?: string;
}
interface LoopRunRecordLite {
  id: string;
  status: string;
}
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

// ---- loop helpers (loopback) ----

async function listLoops(): Promise<LoopLite[]> {
  const res = await bridgeApiFetch("GET", "/api/loops");
  expect(res.status, "GET /api/loops must succeed").toBe(200);
  return (res.body as { loops: LoopLite[] }).loops;
}

async function getLoop(id: string): Promise<LoopLite | null> {
  const res = await bridgeApiFetch("GET", `/api/loops/${id}`);
  if (res.status === 404) return null;
  expect(res.status, `GET /api/loops/${id} must succeed`).toBe(200);
  return (res.body as { loop: LoopLite }).loop;
}

async function runsOf(id: string): Promise<LoopRunRecordLite[]> {
  const res = await bridgeApiFetch("GET", `/api/loops/${id}/runs`);
  expect(res.status, `GET /api/loops/${id}/runs must succeed`).toBe(200);
  return (res.body as { runs: LoopRunRecordLite[] }).runs;
}

/** Poll the loop list until a loop with the given name appears; return its id. */
async function findLoopIdByName(name: string): Promise<string> {
  let id = "";
  await expect
    .poll(async () => {
      const loop = (await listLoops()).find((l) => l.name === name);
      if (loop) id = loop.id;
      return Boolean(loop);
    }, { timeout: 20_000, message: `loop "${name}" never appeared in GET /api/loops` })
    .toBe(true);
  return id;
}

async function deleteLoopQuietly(id: string | undefined): Promise<void> {
  if (!id) return;
  try {
    await bridgeApiFetch("DELETE", `/api/loops/${id}`);
  } catch {
    // best-effort cleanup — the assertion that mattered already ran
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loginAndBridge(page: Page): Promise<void> {
  const email = sharedEmail();
  await login(page, email);
  // Bridge presence enables both the "Create a new session" and "Create a new
  // loop" buttons; this waits on the former as the authoritative online signal.
  await waitForBridgeOnline(page);
}

// ============================ LOOPS ============================

test.describe("loop scheduler / controller", () => {
  test("create -> runs accumulate -> run-now -> disable -> delete", async ({ page }) => {
    // The natural first fire can take up to one 30s tick, and step (3) waits out a
    // further full tick (>30s) to prove disable stops future fires; give the whole
    // flow room above the 90s default.
    test.setTimeout(150_000);

    const name = `e2e-loop-${Date.now()}`;
    const marker = `E2ELOOP${Date.now()}`;
    let loopId: string | undefined;

    await loginAndBridge(page);
    await createLoopViaUi(page, {
      name,
      everyMs: 1000,
      harness: "shell",
      task: `echo ${marker}`,
    });

    loopId = await findLoopIdByName(name);
    const id = loopId;

    try {
      // Keep every run node (default retention prunes to 10) so the counts below
      // are strictly monotonic and never confounded by auto-clear.
      const patch = await bridgeApiFetch("PATCH", `/api/loops/${id}`, {
        body: { retention: { autoClearAfterRuns: null } },
      });
      expect(patch.status, "PATCH retention must succeed").toBe(200);

      // (1) runs accumulate from the scheduler itself (natural tick, <=30s).
      await expect
        .poll(async () => (await runsOf(id)).length, {
          timeout: 45_000,
          message: "scheduler never produced a run record",
        })
        .toBeGreaterThanOrEqual(1);

      // (2) run-now adds an extra run. The skip-overlap guard keys on the actual
      // process being ALIVE (runner.isRunning), NOT on the run-record status —
      // which lingers 'running' for a full ~30s scheduler grace after the shell
      // process already exited (loop-scheduler finalize grace). A shell `echo`
      // exits in milliseconds, so run-now fires; poll until fired:true to stay
      // robust to the rare case where a natural tick's run is momentarily live.
      const before = (await runsOf(id)).length;

      await expect
        .poll(async () => {
          const runNow = await bridgeApiFetch("POST", `/api/loops/${id}/run-now`);
          expect(runNow.status, "run-now must succeed").toBe(200);
          return (runNow.body as { fired: boolean }).fired;
        }, { timeout: 20_000, message: "run-now never fired (kept skipping on overlap)" })
        .toBe(true);

      await expect
        .poll(async () => (await runsOf(id)).length, {
          timeout: 20_000,
          message: "run-now did not produce an extra run",
        })
        .toBeGreaterThan(before);

      // (3) disable -> no NEW runs accrue. Disabling does not kill an in-flight run
      // (it only makes isDue() false on every future tick), and a finalizing run
      // updates its status WITHOUT adding a run node — so run COUNT, not run
      // status, is the honest signal here. Snapshot the count just after disabling,
      // then wait out a FULL scheduler tick (>30s, LOOP_TICK_INTERVAL_MS) — long
      // enough that an *enabled* interval loop would have fired at least once more —
      // and assert the count never moved. That is the proof disable stops future
      // fires, without depending on the 30s run-record finalize grace.
      const disable = await bridgeApiFetch("PATCH", `/api/loops/${id}`, {
        body: { enabled: false },
      });
      expect(disable.status, "disable PATCH must succeed").toBe(200);
      expect((disable.body as { loop: LoopLite }).loop.enabled).toBe(false);

      await sleep(2_000); // let any tick racing the disable settle before snapshotting
      const settled = (await runsOf(id)).length;
      await sleep(35_000); // > one full 30s tick: an enabled loop WOULD fire in this window
      expect(
        (await runsOf(id)).length,
        "a disabled loop must not accrue new runs across a full scheduler tick",
      ).toBe(settled);

      // (4) delete -> gone from the authoritative loop list.
      const del = await bridgeApiFetch("DELETE", `/api/loops/${id}`);
      expect(del.status, "DELETE must succeed").toBe(200);
      expect((del.body as { removed: boolean }).removed, "DELETE must report removed").toBe(true);
      loopId = undefined;

      await expect
        .poll(async () => (await listLoops()).some((l) => l.id === id), {
          timeout: 10_000,
          message: "deleted loop still present in GET /api/loops",
        })
        .toBe(false);
      expect(await getLoop(id), "GET /api/loops/:id must 404 after delete").toBeNull();
    } finally {
      await deleteLoopQuietly(loopId);
    }
  });

  test("preflight non-zero -> skip recorded, no run spawned", async () => {
    // createLoopViaUi exposes no preflight field, so this drives the loopback
    // create route (POST /api/loops) directly — the cheap, deterministic path.
    const name = `e2e-preflight-${Date.now()}`;
    let loopId: string | undefined;

    const create = await bridgeApiFetch("POST", "/api/loops", {
      body: {
        name,
        // bridgeId is forced to the running bridge by the controller; any value works.
        bridgeId: "ignored-forced-by-controller",
        schedule: { kind: "interval", everyMs: 1000 },
        harness: "shell",
        task: "echo should-never-run",
        enabled: true,
        overlapPolicy: "skip",
        retention: { autoClearAfterRuns: null },
        // /bin/sh -c 'exit 1' -> non-zero -> the scheduler ABORTS: skip, no session.
        preflight: { command: "exit 1" },
      },
    });
    expect(create.status, "POST /api/loops must create the loop").toBe(201);
    loopId = (create.body as { loop: LoopLite }).loop.id;
    const id = loopId;

    try {
      await expect
        .poll(async () => (await getLoop(id))?.skipCount ?? 0, {
          timeout: 45_000,
          message: "preflight-failing loop never recorded a skip",
        })
        .toBeGreaterThanOrEqual(1);

      const loop = await getLoop(id);
      expect(loop?.lastStatus, "a skipped fire sets lastStatus=skipped").toBe("skipped");
      expect(loop?.runCount, "a preflight skip must NOT spawn a run").toBe(0);
      // The skip path returns before creating a run node.
      expect((await runsOf(id)).length, "a skip creates no run record").toBe(0);
    } finally {
      await deleteLoopQuietly(loopId);
    }
  });
});

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
