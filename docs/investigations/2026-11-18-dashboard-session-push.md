---
type: investigation
slug: dashboard-session-push
date: 2026-11-18
branch: perf/dashboard-polling
status: locally-verified
---

# Dashboard push delivery

## Goal

Remove timer-driven dashboard reads. A quiet, visible dashboard previously sent four `list_sessions`, four `get_sessions_usage`, and (with Overview open) four `get_session_board` requests per minute, per bridge. Startup also requested attention separately for every session.

## Accepted contract

- `sessions:updates` uses positioned recovery. Session snapshots are read on initial readiness, unrecovered subscription/position loss, visibility return, and explicit reconciliation. Existing manual refresh and mutation rollback reads remain available.
- Account-scoped `session-board:updates` publishes the existing Overview `BoardSnapshot`, coalescing changes for about one second and skipping unchanged snapshots. Oversized snapshots use a small `session_board_changed` marker that requests an authoritative read.
- Overview reads on entry, unrecovered subscription, visibility return, or an oversized marker. A relay without the new namespace remains usable through entry and visibility reads.
- Usage reads occur only while its view is rendered and visible, on entry, visibility return, and relevant pushed session changes. No recurring network timer is needed.
- Attention hydration uses a bridge-scoped batched command returning only attention-bearing sessions. Older bridges retain the per-session fallback.
- Existing encrypted transport and account-channel permissions apply to both update channels. Browser command admission and read-command classification must include the new batched read.
- Complete plans come from the authoritative board snapshot; dashboard session rows omit the duplicate plan. Ordinary local HTTP session responses retain it. Oversized board reads use immutable, checksummed chunks through `get_session_board`, with a sixty-second cache lifetime, four entries and a combined sixteen-MiB cache budget.
- Relay configuration changes are reviewed separately and are not deployed by this task.

## Evidence boundaries

The initial WIP tested injected subscription callbacks. Those tests prove reducer behavior but do not prove live relay delivery or reconnect recovery. Its proposed sixty-second safety poll does not satisfy the accepted contract and is superseded.

Focused hook tests exercise idle request counts, positioned recovery, visibility, older relay behavior, target filtering, attention batching, and deferred encrypted publication handling. Bridge tests exercise snapshot coalescing, change sources, encrypted payload sizing, publication completion, and command admission. Live runtime validation uses the isolated E2E stack; exact results are recorded after execution.

## Relay configuration inventory

Each of `centrifugo/config.json`, `centrifugo/config.prod.json`, `centrifugo/config.fly.json`, and the test fixture `e2e/centrifugo.config.json` changes separately:

1. `sessions`: history size 500, TTL one hour, forced recovery enabled.
2. New `session-board` namespace: history size 5, TTL sixty seconds, forced recovery enabled, with the same namespace permissions as `sessions`.

The executable configuration contract and its tests track all four files. This checkout uses native Centrifugo namespace rules; it does not configure a separate connect proxy.

## Verification

- Bridge build: passed on Node 24.22.1.
- Full bridge unit suite: 3,565 passed, five skipped, zero failed. Subsequent dashboard projection checks: 85 passed, including maximum legal plan encryption and lossless board reconstruction; rebuilt successfully.
- All four relay configurations passed upstream Centrifugo 6.10.2 `checkconfig`; configuration contract tests passed (21).
- Isolated real-broker smoke: passed account subscription isolation, authenticated application filtering, and positioned session/board recovery; scratch hub cleaned up.
- UI production build: passed on the final application source. Full unit suite: 2,358 passed; focused final hook suites: 103 attention tests and 97 session tests passed.
- Attention summaries preflight their full response byte size. An explicit size response permits bounded client bisection; other failures do not enable that fallback.
- Independent non-author review: complete.
- Focused E2E: live plan publication, child attention/answering, and external session create/rename/remove passed without a document reload. Existing desktop/mobile Overview scenarios and focused CRUD lifecycle also passed. The local run used the supported `http://localhost:3000` origin and isolated scratch services/database; cleanup completed.
- A collapsed-section selector in the new E2E test was corrected after the rendered summary proved the push had arrived. No application assertion was weakened.
- Latest main attention diagnostics were merged, independently reviewed, and checked with 100 focused tests, a fresh production build, live push/Overview tests, and the affected preview/reply E2E case. Scratch bridge `ftown harness status` passed. Desktop/mobile renders were reviewed.
- The first full CI E2E run exposed two reproducible races: separately delivered subscription callbacks invalidated a shared attention snapshot, and pre-attachment resize requests were lost during terminal resurrection. Both received causal regressions and scoped fixes. All five failed attention cases passed locally afterward, and the restart case passed three repetitions alongside the bounded full bridge suite (3,578 passed, five skipped). The attention hook's 103 focused tests, static check, production build, and independent review passed. CI results are tracked on the pull request.
- Subsequent CI confirmed those six cases passed, but exposed a pending initial inventory read that did not resume when a later publisher completed security readiness. The existing runtime readiness event now resumes only pending reconciliation, with bounds and identity/visibility guards. Real-RPC regressions, nine repeated cold-start browser cases, live push, the final UI suite/build, and independent review passed before pushing the repair.

## Steady-state request rate

For one idle visible dashboard, one bridge, and Overview open:

| Command | Before (requests/minute) | After (timer-driven requests/minute) |
| --- | --- | --- |
| `list_sessions` | 4 | 0 |
| `get_session_board` | 4 | 0 |
| `get_sessions_usage` | 4 | 0 |

Startup, visibility return, unrecovered subscriptions, explicit refreshes, and change-triggered reads are excluded. Modern attention startup uses one summary per bridge (up to 500 IDs) and no per-session reads for empty results; larger authorized summaries split only when needed. Older bridges retain a bounded legacy compatibility path.

Security review artifacts are excluded from the public repository.

## Rollout compatibility

- Until the active tree receives a board publication, relevant session changes get one coalesced Overview read. A successful child attention action also refreshes Overview when board delivery is unavailable. A matching push cancels the queued fallback. A hidden tab defers reconciliation to visibility return.
- Fresh subscriptions omit a recovery position. A reconnect or renewed subscription with a known epoch resumes from that position. The pinned Centrifugo smoke verifies that both channels skip old history on entry and replay the exact missed publication on recovery.
- A bridge reconnect starts board reconciliation from its live trees and retains pending changes to stopped trees. It probes the namespace with one publication before allowing two acknowledged deliveries at a time. An unknown namespace suspends board work until the next reconnect.
- A loopback `400 invalid_command` on the attention-summary read uses a single authorized legacy read to establish compatibility. Modern summaries revalidate read permission before and after collecting attention.
- Board chunks share one expiry timer while the cache has entries. The timer releases expired bytes even after the final read and stops when the cache empties.
