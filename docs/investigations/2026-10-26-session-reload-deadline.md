---
type: investigation
symptom: "Valid encrypted session snapshots disappear after the hook expires correlation too early"
slug: session-reload-deadline
date: 2026-10-26
git_commit: 41e96178c050871cd95507502bc3ab87316dc3b5
branch: codex/fix-session-reload-deadline
status: root-cause-proven
---
# Session list reply deadline

The user reports second computer 277066ac-69d5-440e-934f-b4a8e4a6ebba appears online in both browsers but sessions disappear after reload. Its CLI returns eight running sessions with matching bridge IDs. Its persisted approval includes the current browser WhfDjvxYtX2nYvm6Xnn23uc7yM4gljIDL8SPmTcAk3g. The account roster also lists that browser. Startup logs show list_sessions, attention and usage commands arriving. Earlier account-read throttle is not active (seven requests, no lock). Exact live browser timing remains unavailable.

## Hypotheses
1. Missing or revoked current-browser approval: rejected for the second PC browser by matching public fingerprint and persistent read/control/admin grant with no expiry.
2. Invalid historical session row rejects entire snapshot: rejected for this incident; all eight supplied rows match the bridge and pass the production row validator.
3. Correlation expires before the transport deadline: proven as an independent reload defect, not yet established as the live incident's cause. useSessions keeps list requests for 30 seconds while SecureMessageClient accepts authenticated responses through its 40-second budget.
4. One bridge invitation replaces browser identity or poisons another bridge: rejected by isolated owner/bridge pin writes and independent delivery.

## Reproduction and falsification
Worker executed a pure production-hook/adapter probe, no network or DB: /tmp/ftown-list-window-probe.cjs, evidence .md.
40-second adapter budget: response at 29 seconds accepted with one row; at 35 seconds adapter accepts but hook yields zero rows; at 41 seconds adapter rejects and hook yields zero.
30-second adapter budget: 29 seconds accepted, 35 seconds rejected.
The adjacent early/expired cases falsify a blanket parsing failure and demonstrate a mismatched deadline.

## Five whys
Rows absent because a valid reply is ignored; reply ignored because its correlation entry was pruned; entry pruned after 30 seconds despite a 40-second transport budget; the hook hardcodes a separate budget; adapter/hook timing contracts lacked a shared budget and boundary regression.

## Frozen contract and ownership
Shared checkout /Users/fkesheh/projects/ftown-simplify-all. Native implementation/integration owner /root/existing_pwa_access explicitly gpt-6.1-sol/high owns ONLY ui/src/hooks/useSessions.ts and ui/src/hooks/useSessions.test.ts. Root owns this report. Native reviewer /root/rate_window_review explicitly gpt-6.1-sol/high is read-only. Exact paths are disjoint; no parallel application writers.
Use finite positive client.commandTimeoutMs, including shorter budgets, otherwise existing 30-second fallback. Do not alter transport deadlines, authentication, approval, request IDs, generation checks, per-bridge cutoffs or tombstones.
Tests: valid authenticated 35-second response retained with 40-second adapter; at/after40 rejected; absent/invalid timeout fallback; existing multi-bridge reconciliation intact.
Independent preimplementation contract review PASS. Worker isolated unit/static checks only; root exclusively runs E2E/CI/servers/DB. Preserve four preexisting dirty notes and unrelated primary checkout. Git integration exclusive worker lease; no merge/deployment.

## Implementation handoff
Two regression failures on old code; repaired focused suite 77/77, full UI suite 642/642 across 66 files, UI noEmit and scoped whitespace checks passed on Node24.22.1. Four protected notes remain hash-identical. Source writes stopped and leases released. Independent two-file review reports no material findings. Root will run existing isolated CI against reviewed branch; existing e2e/env.sh selects only ftown@localhost/ftown and Docker-owned services with cleanup. No production database mutations or trust changes for this repair. Live causality remains unconfirmed.
