---
type: investigation
symptom: "Since about 2026-10-26, ftown has generated a very large number of Vercel observability events"
slug: vercel-function-events-flood-from-approval-polling
date: 2026-11-08T10:50:00-03:00
investigator: Foad Kesheh
git_commit: 765237f
branch: fix/security-approval-polling
repository: fmktech/ftown
status: resolved
hypotheses_formed: 5
hypotheses_rejected: 4
hypotheses_proven: 1
related:
  - docs/investigations/2026-11-07-ui-slow-typing-and-switching-with-multiple-bridges.md
---

# Vercel function events flood since Oct 26

## Symptom
The user's report: "after oct 26 ftown is generating a toon of observability events, can you check"

- **Observed:**
  - The Vercel Logs for project `ftown`, over the timeline "Last week", show **783K** "Vercel Function" events, against 290 Cache and 172 Rewrites.
  - The sample in the user's screenshot (2026-11-08 10:46:40–10:46:50) is almost all `GET ftown.ia.br/api/security/approvals` with status 200, plus some interleaved `GET /api/security/account`.
  - The approvals timestamps fall into three phases, each repeating every 2 s: `.56`, `.96/.97` and `.14/.15`.
- **CLI cross-check:** `vercel logs --project ftown --scope fkesheh-s-team --environment production --since 2h --json` returns at most 50 rows, here covering 26 s:
  ```
  42 serverless GET /api/security/approvals
  8 serverless GET /api/security/account
  ```
- **Expected:** an idle dashboard should cause near-zero function invocations. Approval traffic should exist only while a pairing or approval is actually in progress.
- **Delta:** about 1.5 approvals requests per second, around the clock (≈ 130K/day), plus about 0.3 account reads per second. The volume does not depend on whether any approval exists.

## Reproduction
1. Pull the latest production function logs and compute the approvals rate and the number of 2 s phases, clustering on `timestamp mod 2000` within 150 ms. Raw files are in `scratchpad/obs/`.
2. Open ONE new dashboard tab at https://ftown.ia.br, leave it idle and visible, and record its resource timings.
3. Pull the logs again while the tab is open, then again ≥ 60 s after closing it.

Results (2026-11-08):

| State | approvals/s | account/s | 2 s phases |
|---|---|---|---|
| BEFORE (user's clients only) | 1.5 | 0.2 | 3 (two merged in one 261 ms-wide cluster) |
| DURING (+ one idle tab) | 2.0 | 0.27 | 4 |
| AFTER (tab closed > 60 s) | 1.58 | 0.30 | 3: (966–1227 ms, 28 rows = 2 pollers), (1562–1578 ms, 14 rows = 1 poller) |

What the measurement tab itself saw:
- **86 `GET /api/security/approvals` in 156 s, one phase, gaps of 2000 ms ± 8 ms.**
- `GET /api/security/account` twice at load, then every 30.0 s.
- One approvals response was a 503.

Verified 2026-11-08: the symptom reproduces on demand. Each open dashboard adds exactly 0.5 approvals req/s.

## Hypotheses

#### H1: The dashboard's reviewer-mode `usePendingApprovals` polls `GET /api/security/approvals` every 2 s unconditionally, from every open dashboard instance
- **Layer:** code-logic
- **Prediction:** one idle dashboard produces one approvals GET every 2 s with nothing pending. Opening or closing a dashboard adds or removes exactly one 2 s phase in Vercel. The hook first appears on 2026-10-26.
- **Evidence:**
  ```
  ui/src/hooks/usePendingApprovals.ts:15-16
    const poll = () => { ... else if (mode === "reviewer") { void resource.client.refreshInbox(); void resource.client.pollReview(); } };
    poll(); const timer = setInterval(poll, PENDING_APPROVAL_LIMITS.pollIntervalMs); window.addEventListener("focus", poll);
  bridge/src/security/pending-approval-crypto.ts:18   lifetimeMs: 300000, pollIntervalMs: 2000, requestTimeoutMs: 15000,
  ui/src/components/Dashboard.tsx:128   const pending = usePendingApprovals(accountClient, "reviewer");
  git log -- ui/src/hooks/usePendingApprovals.ts → f51fb4f 2026-10-26 Automatic pending device approvals with resilient reload a... (#138)
  measurement tab: 86 approvals GETs / 156 s, inter-arrival 2000 ± 8 ms, single phase
  Vercel: BEFORE 1.5/s (3 phases) → DURING 2.0/s (4 phases) → AFTER 1.58/s (3 phases)
  ```
  The poll has no visibility check, no "something pending" condition and no backoff. It stops only on unmount; `refreshInbox` merely skips while a previous request is in flight (`pending-approval-client.ts:256-259`).
- **Server cost per call:** `pendingInbox` (`ui/src/lib/pending-approval-http.ts:23`) runs `auth()` and a rate-limit upsert (`_shared.ts:33`, limit 200 per 60 s per owner), then queries `users` (`pending-approval-store.ts:105`) and selects the inbox (`:119`). That is 3 DB statements, uncached, on every poll.
- **Verdict:** PROVEN.
- **Rationale:** the predicted per-tab rate, phase, onset date and open/close counterfactual were all observed.

#### H2: A single page mounts several independent reviewer pollers, so one tab accounts for all three 2 s phases
- **Layer:** code-logic
- **Evidence:**
  - The measurement tab showed a single phase.
  - `SecurityDevices.tsx:189` mounts the hook in `"passive"` mode, reusing the Dashboard's client (`Dashboard.tsx:1244`).
  - `DeviceApproval.tsx:41` runs only on `/devices/approve`.
  - `PendingDeviceApprovals.tsx:29` is candidate mode.
- **Verdict:** REJECTED.
- **Rationale:** one dashboard tab runs exactly one reviewer poller (measured and confirmed in code).

#### H3: The flood comes from abnormal client multiplicity (leaked or zombie dashboards) rather than from the per-instance polling rate
- **Layer:** state-data / environment
- **Evidence:** the user's baseline is 3 pollers, i.e. three open dashboard instances: tabs, a PWA, or other devices. That is ordinary usage. Each instance alone costs 0.5 req/s ≈ **43K invocations/day**.
- **Verdict:** REJECTED as the cause.
- **Rationale:** multiplicity scales the cost linearly, but the defect is the unconditional 2 s rate per instance. Even one dashboard would generate about 300K events per week.

#### H4: The `GET /api/security/account` bursts come from the approvals poller's `trusted()` path, i.e. 401/403 on approvals leading to an account refresh on every poll
- **Layer:** code-logic / integration
- **Evidence:**
  - `trusted()` refreshes the account only when `inboxError === "account_approval_required"` (`pending-approval-client.ts:262`).
  - Approvals responses are 200 in the logs.
  - The measurement tab made account GETs every 30.0 s, not once per poll.
  - Account reads come from `useAccountSecurity.ts:16-17` (30 s per tab, d2701bc, 2026-10-25, #136) and from each bridge's account poll (`bridge/src/security/bridge/security.ts:264`, 30 s, the same PR).
- **Verdict:** REJECTED.
- **Rationale:** account traffic is a separate 30 s poll per tab and per bridge, at about 0.3/s, roughly 16% of the volume. It does not come from the approvals loop.

#### H5: Traffic did not change; Vercel began counting or retaining more event types around Oct 26 (observation artifact)
- **Layer:** observation
- **Evidence:**
  - The dominant route's poller did not exist before f51fb4f (2026-10-26).
  - Opening a single tab measurably adds the traffic, and closing it removes it.
- **Verdict:** REJECTED.

## 5 Whys
- **Symptom:** about 783K function events per week (≈ 130K/day), dominated by `GET /api/security/approvals`.
- **Why 1?** Every open dashboard runs a reviewer poller that fetches the approvals inbox every 2 s: 0.5 req/s, or 43K/day per dashboard. The user keeps three dashboards open.
- **Why 2?** The always-on reviewer inbox reused `PENDING_APPROVAL_LIMITS.pollIntervalMs = 2000`. That constant was designed for the short-lived candidate and pairing handshake, which is bounded by its 5 min `lifetimeMs`. The reviewer loop added no gate for visibility, for whether anything is pending, or for errors and backoff.
- **Why 3?** A dashboard can learn that a new approval request exists only by polling a Vercel function. Nothing pushes "inbox changed" to reviewers, even though every dashboard already holds a Centrifugo connection. Each poll also costs 3 uncached DB statements.
- **Why 4?** The account-trust features (#135–#139, 2026-10-25/26) were designed for correctness and resilience, and had no budget for background request volume. Serverless invocations and DB statements per idle tab were not a design input.
- **Why 5?** No guard catches background polling volume: no per-tab request budget in tests, no review checklist item, and no alert on function-invocation rate. The spike ran unnoticed for about two weeks.

## Falsification
- **Counterfactual (open/close):** one added idle tab raised Vercel approvals from 1.5/s to 2.0/s and added exactly one 2 s phase. After the tab closed, the rate returned to 1.58/s with the original 3 phases. The cause is present iff the traffic is present.
- **Absence:** the polling hook did not exist before 2026-10-26 (`git log`), which matches the reported onset. Before it, nothing in the codebase polled approvals outside bounded pairing (`bridge/src/pairing-client.ts:304`, 2 s for at most 5 min).
- **Adjacent cause:** account polling at 30 s per tab and per bridge was checked. It contributes about 0.3/s, roughly 16%, and does not explain the 2 s phases.
- **Conclusion:** H1 survived.

## Root Cause
- **Immediate cause:** `ui/src/hooks/usePendingApprovals.ts:15-16`, mounted unconditionally at `ui/src/components/Dashboard.tsx:128`. It polls `GET /api/security/approvals` every 2000 ms (`bridge/src/security/pending-approval-crypto.ts:18`) for as long as any dashboard is open, regardless of visibility, of whether anything is pending, or of errors. Each poll is a function invocation plus 3 DB statements.
- **Architectural root:**
  - There is no push signal for approval-inbox changes.
  - The handshake-grade 2 s interval was reused for an always-on loop.
  - There is no budget or guard on background request volume.
- **Rejected:**
  - H2: one tab runs one poller.
  - H3: three dashboards is normal usage; one alone is about 43K/day.
  - H4: account traffic is a separate 30 s poll at about 16%.
  - H5: the traffic is caused by the hook and is reproducible per tab.

## Fix
The first proposal was adaptive polling: visible only, 30 s. It still meant about 2.9K invocations per day for each visible dashboard, which the user rejected ("nao tem motivo para isso rodar 2,9mil vezes por dia"). The final design removes periodic polling entirely and attacks Why 3, the missing push signal.

**Mechanism.** After a successful change, the client that made it publishes a content-free nudge over Centrifugo:

```
{"type":"ftown_security_changed","version":1,"scope":"approvals"|"account"}
```

- **Channel:** `bridges:security#<user>`. The `bridges` namespace already allows client publish and user-limited channels in every Centrifugo config and in the Solo hub, so no configuration change is needed.
- **Receivers:** they accept only publications whose `info.user` is the owner, then run one authenticated fetch. Fetches are coalesced, with at least 1 s between them per scope.
- **Resync:** every (re)subscription triggers a resync, so a nudge missed during a disconnect is recovered.
- **Candidates without a connection:** browsers on the approval page publish through a one-shot connection, using `POST /api/auth/token`.

| Code | Change |
|---|---|
| `bridge/src/security/security-nudge.ts` (new, shared) | Channel, strict parser, constants, coalesced trigger |
| `ui/src/lib/security-nudge-bus.ts` (new), `DashboardClient.tsx` | Page bus: owner check, resync, queued and one-shot publish |
| `ui/src/lib/pending-approval-client.ts`, `account-security-client.ts` | Publish after each successful mutation. Expired inbox entries drop locally, with no fetch |
| `ui/src/hooks/usePendingApprovals.ts` | The reviewer inbox no longer polls every 2 s. It fetches on mount and on nudge. The 2 s polling remains only while a review is active, bounded to 5 min |
| `ui/src/hooks/useAccountSecurity.ts` | The per-tab account read no longer polls every 30 s. It fetches on mount and on nudge |
| `bridge/src/centrifugo-client.ts`, `security/bridge/security.ts`, `index.ts` | The bridge re-reads the account on nudge or resubscribe, and as a safety measure every 1 h instead of every 30 s |

**Expected volume** for the user's idle setup of 3 dashboards and 4 bridges:
- **Approvals:** about 130K/day before, 0 periodic after.
- **Tab account reads:** about 8.6K/day before, 0 after.
- **Bridge account reads:** about 11.5K/day before, 96/day after.
- **Remaining:** one-off resyncs on page load and reconnect.

**Regression tests:** each one fails on the current code.
- `usePendingApprovals` reviewer mode, idle for 10 min: exactly 1 fetch. Today the hook makes about 300.
- `useAccountSecurity`, idle for 10 min: 1 fetch. Today it makes about 20.
- Bridge: no account read for 59 min after startup.

**Follow-ups:** candidate-mode 2 s polling while waiting for approval is still bounded only by the request lifetime. Server-side publishing would remove the one-shot path.

## Resolution
**Review-driven amendments.** Separate reviewers found the problems below, and all were fixed before the PR:
- **Candidate polls were treated as mutations.** The candidate's 2 s poll is a re-sent idempotent create. Counting it as a mutation would have published, and opened a one-shot connection, every 2 s. Publishing is now an explicit allowlist of state-changing actions. A full approval flow publishes 6 nudges in total, and 90+ polls publish none.
- **Review polling stopped too early.** It stopped at `approved`, which would have stalled delivery-bundle renewal. Review polling now continues through `approved` and is capped at the 5 min request lifetime.
- **Nudges could be absorbed by stale reads.** A nudge arriving during an in-flight read joined it, and that read could predate the change. This happened in the UI and in the bridge. Both now use `refreshFresh()` / `refreshInboxFresh()`, and the bridge trigger does the same, so one fresh read runs after the in-flight one.
- **The bridge trusted push without checking it.** It now trusts push only while the push is healthy. It waits 1 h only while the nudge subscription is `subscribed` and the last read succeeded; otherwise it waits 30 s. That covers unsubscribed, disconnected, Centrifugo outage and failed reads. Losing health pulls the next read in. The scheduling deadline uses a monotonic clock.
- **Second publisher.** The candidate also publishes `account` when it completes enrollment, so a newly approved device's first hello never depends on a single nudge.
- **ES2017 compatibility.** `bridge/src/security/**` is type-checked by the UI at ES2017. The shared module uses no BigInt literals or numeric separators.
- **Contract doc.** `docs/investigations/2026-10-25-account-trust-contract.md` gained a dated v1.3 amendment describing the new freshness guarantees.

**Regression tests.** Each one fails on the original code.
- `ui/src/hooks/usePendingApprovals.test.ts`: in reviewer mode, idle for 10 min, there is exactly 1 inbox fetch. The original hook makes 301.
- `ui/src/hooks/useAccountSecurity.test.ts`: idle for 10 min, there is 1 account fetch. The original makes 22.
- `bridge/src/security/bridge/account-refresh.test.ts`: healthy and idle, there are no reads for 59 min and one at 60 min. The original makes 118 reads by 59 min.

**Verification.**
- UI: 1440/1440 pass, against 1391 on base. `tsc` is clean.
- Bridge: 1384 tests. The same 24 environmental failures occur as on base, with none new. `tsc` is clean.
- Every diff was reviewed by a separate agent. Security review covered the nudge bus and the bridge side.

**Expected effect** for the user's idle setup of 3 dashboards and 4 bridges:
- before: about 150K function invocations per day;
- after: about 96 per day (4 bridges × 24 hourly safety reads), plus one resync per page load or reconnect and one fetch per real change.

**Follow-ups.**
- Server-side publishing would remove the one-shot path.
- Candidate-mode 2 s polling remains while a device waits for approval. It is bounded by the request lifetime.
