# Native mail delivery coordination

- Request: prefer native adapters for FTown mail delivery.
- Shared branch: `feat/native-mail-delivery`, based on main `804370e88312278d3446e653594b274da5300c93`.
- All three prior workers were completed before dispatch; explicitly selected model/effort retained as gpt-6.1-sol/high. Native IDs are the canonical agent names in ownership.json.
- Independent pre-freeze review accepted wake-only transport, retaining durable inbox consumption. No new claims queue or MCP layer.
- Contract v1 and exact file ownership are authoritative. Workers share checkout, must preserve unrelated edits, and may not expand writable scope without ownership transfer. No worker starts E2E/server/database/CI.
- Current phase: parallel implementation, then peer review, root runtime verification, per-owner repairs and integration PR.
- Required scope: Claude Mod, Codex native wake, verified Muse support or explicit fallback, OpenCode native idle wake/retained inbox, Pi compatibility, legacy fallback.
- Root owns all runtime fixtures and cleanup; npx_implementation owns Git/package mutations. Four unrelated investigation notes are excluded from commits.

## Verification evidence

- Root loaded the copied Mod in a real Claude Code 2.1.302 interactive session, using an isolated HOME/config/workspace and dummy API key directed at loopback port 1. FTown variables were absent, so the Mod stayed inert. No model prompt was sent. Generated exact installed API declarations; exited cleanly. Claude worker checked the module against those declarations with strict checkJs and validated it with `claude plugin validate --strict`.
- Root ran Muse 1.4.10 echo-provider probes in scratch homes. First stripped-preset probe refused external ingress; a second probe using the normal default preset confirmed both idle and busy native sends return schema 1, `status: unavailable`, `error_code: external_agent_ingress_closed`, empty receipts. The receiving TUI remained live and processed an ordinary typed echo prompt. No external message appeared. Therefore this release retains existing Muse hooks/PTY fallback; native Muse admission is not enabled. Probe-owned processes/data were cleaned in finally. These are negative capability results, not passing native delivery tests.
- Early isolated unit evidence: mail core/OpenCode 38 passing; Claude/installer/registry-related 100 passing; native CLI adapter 7 passing. Final combined checks remain pending.
- Review corrections in progress: harness-specific native identity selection, post-await busy recheck, generation fencing before Mod submission, and compatibility with web-panel-generated Claude commands. Native command boundary gained optional cancellation/final revalidation callbacks before dispatch.

- Root real Codex 0.163.0 loopback-provider probe PASS: native queue accepted both idle and busy input for the same scratch UUID; idle input reached that session; busy input waited behind a held active request and became one follow-up after release. Auxiliary provider calls were separated from the four intended native-input turns. No real model or credentials; scratch daemon/processes and server cleaned.
- Root real Claude 2.1.302 Mod loopback-provider probe PASS: idle wake starts a turn, another message while busy waits, seven heartbeat polls continue, exactly two wake turns for the two unread arrivals, and mailbox body marker never reaches the model. Uses ordinary permission mode, no active permission bypass. Temporary home/config/plugin copy, PTY and both servers cleaned. Initial fixture failure was the wrong dummy-key approval configuration field; corrected before the passing run.
- Independent reviews closed: all native/core/Claude changes reviewed by another worker. Final OpenCode regression covers a competing pre-existing root after late loading; disable native wake and expire lease instead of sending into an uncertain conversation. Recoverable errors keep polling. All application writers stopped; integration owner has build/package leases for version 0.19.47.

## Integration gate

- Final bridge build PASS, version 0.19.47. Claude Mod assets included in both npm artifacts; release/artifact suite 16/16 PASS, including real payload parity under npm 11.6.2.
- Root full bridge suite PASS: 839 passed, 4 skipped, 0 failed (843 tests). Includes authenticated heartbeat HTTP tests and existing Pi/mail coverage.
- Root installed-package E2E PASS: copied npm-shaped package installed in scratch HOME; original cache removed; installed bridge started in local-only mode; required `ftown harness status` passed; native command wake contains only pointer; message remains pending until read and second read is empty; malformed, mismatched and stopped heartbeat registrations rejected. No cloud or database. All owned sessions, process group and scratch files cleaned.
- Root native runtime acceptance PASS for Claude and Codex as above. Muse native ingress remains unavailable, with existing fallback retained. OpenCode checked with isolated native-client/lifecycle fixtures, not a live provider model. Browser/full cloud E2E was not required for this backend change.
- All implementation and review agents are completed/stopped and have released application/build/test resources. Only integration owner will be reactivated for commit/push/PR. Four unrelated user investigation edits remain excluded.
