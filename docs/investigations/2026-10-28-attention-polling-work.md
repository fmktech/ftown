# Attention polling investigation and delivery

## Task A: investigate (active)
Tier 1: gpt-6.1-terra, xhigh. Shared checkout: /Users/fkesheh/projects/ftown.
Exclusive writable file: docs/investigations/2026-10-28-attention-polling.md.
All source/runtime files read-only. No source changes, installs, Git mutations, servers, E2E, or runtime upgrades. Others share this checkout; preserve all existing edits. Root owns integration and runtime resources. No parallel source writers.
Outcome: identify actual running bridge version and source of get_session_attention traffic; distinguish noisy logging, excessive polling and version mismatch. Current checkout lacks this command and has extensive unrelated dirty changes. Do not assume current checkout is deployed.
Use Semble for implementation discovery (CLI fallback); literal rg allowed for all exact occurrences. Prefix shell commands with rtk. Read debug skill and meet evidence gate in assigned investigation report where evidence permits; never invent proof. Inspect installed runtime and Git remote refs read-only, bounded logs and processes, without printing secrets. No new agents.
Contracts: existing createCommandHandler(CommandRpcDeps) and wire command contracts remain read-only; discover actual UI polling and handler versions. No new interfaces yet.
Acceptance: report exact producer/interval/lifecycle if available, runtime path/version, handling behavior, deterministic isolated repro approach, smallest safe fix and exact owned file proposal/check commands. Evaluate three hypotheses across layers and falsification; unresolved deployment facts remain explicitly unknown. Provide branch/base recommendation preserving current dirty work. Handoff findings, commands/results, proposed files, limitations, release report lease. Root executes any E2E.

## Dispatch and workspace
Task A native agent: /root/attention_fix, Tier 1 gpt-6.1-terra xhigh.
Root created ONE shared task worktree /Users/fkesheh/projects/ftown-attention-polling at ebd108e on fix/attention-polling-noise because original checkout has 94 unrelated changes. All implementation uses this worktree. Root owns dependencies, Git landing, E2E, coordination artifact. Dependency install in bridge running under root lease.

## Task B: bounded logging fix (pending investigation gate and independent contract review)
Worker: reuse /root/attention_fix, Tier 1 gpt-6.1-terra xhigh; integration implementation owner same worker, root owns Git.
Exact writable files: bridge/src/command-rpc.ts, bridge/src/command-rpc.test.ts, docs/investigations/2026-10-28-attention-polling.md, docs/bridge-command-logging.md. No other writes.
Frozen existing interfaces: createCommandHandler(CommandRpcDeps) and Command/CommandResponse remain unchanged; do not change UI hydration, attention persistence, authorization, targeting, response shapes, publishing or transport.
Behavior: move receipt logging after existing bridge-target rejection. Suppress get_session_attention receipt logs by default only. FTOWN_DEBUG_COMMANDS=1 enables those receipt logs for this bridge; other values do not. Preserve other commands receipt logs. Preserve failure responses and existing publish-error logging. Do not add new failure logging or expose payload/attention content. Document opt-in, restart requirement, exact scope, and that this is event-driven hydration rather than a timer.
Acceptance: regression tests prove default owned attention read has no receipt log but same successful response, foreign commands have no logs/response even in debug mode, owned debug attention logs exactly once, non-1 settings stay quiet, non-attention commands still log, failed attention reads still respond with failure, publishing errors remain logged. Restore console/env mocks using test cleanup. Demonstrate new tests fail on baseline, pass with fix. Run node --import tsx --test src/command-rpc.test.ts and npm run build under Node 24.22.1 after root releases dependency lease. No E2E/server runs; root owns those. No installs or Git mutations. Escalate contract changes to root. Handoff exact changed files, tests/results, limitations and release all file leases.

## Task C: independent review
Tier 1 gpt-6.1-terra xhigh. Read-only source and coordination; sole writable report docs/investigations/2026-10-28-attention-polling-review.md. Pre-freeze review Task B contract for correctness/scope, then post-change review runtime and logging tests; no E2E/server/Git/install. Report concrete defects, not speculative redesign. Others share checkout; never revert edits. Root integrates.
Ownership mechanically disjoint: B four exact files, C review report, root coordination file and generated dependency/build outputs. No overlapping source writers.

## Pre-freeze review accepted
Reviewer /root/attention_review, Tier1 gpt-6.1-terra xhigh, approved behavior with mandatory versioning correction. Task B additionally exclusively owns bridge/package.json and bridge/package-lock.json, using npm version patch --no-git-tag-version per bridge/AGENTS.md. Root dependency install complete and lease released; worker now owns version mutation and build output. Documentation must qualify event-driven hydration as inspected current UI, not proven deployed UI. Contract frozen with these corrections. Investigation gate satisfied by copied report. Task C source ownership remains read-only; no path overlap. Root will execute focused runtime check after handoff.

## Final gates
B complete: regression RED on baseline, GREEN 9/9 command RPC tests, build passed on Node 24.22.1. C independent review PASS no blockers. All source/report leases released; both native workers completed, no native close API exists. Root compiled-runtime smoke: 80 successful attention reads, zero receipt logs; foreign ignored, debug opt-in prints. Root existing default-start-smoke passed version 0.19.59, local startup/installed alias/harness status; isolated HOME, localhost-only API, no cloud/providers/database, owned processes and scratch resources removed. Original running bridge untouched. No browser E2E needed for receipt-only change; no UI behavior changed. Root owns Git landing.
