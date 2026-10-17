# Independent review

Reviewer: `/root/review_all`, explicitly `gpt-6.1-sol` / `high`.
Shared checkout: `/Users/fkesheh/projects/ftown-simplify-all`.
Writable scope: this report only. Application code, Git, installs/build outputs, and E2E resources remain unowned/read-only here.

## Pre-freeze contract review

Contract accepted, with these concrete implementation/verification edges:

1. Retire assets by exact managed identity, never by skill name or `SKILL.md` alone. Preserve customized trees, added files/directories, symlink roots/parents, unrelated absolute/relative links and independent agent skills. Cover legacy real-directory copies if an immutable shipped inventory is available. Existing `install-ftown-skill.ts` supplies a conservative hash-inventory precedent.
2. Preserve the whole `~/.ftown/workflows/` run-data tree. The old workflow installer copied `ftown-workflows`, `ftown-workflows-cli.js`, `workflow-runner.js` and `claude-trust.js`; retirement may delete only proven managed executable assets, and must retain modules still used by other installed CLIs. Do not delete the shared `.ftown` directory.
3. Source deletion is insufficient for packaged retirement: `tsc` does not delete old `dist` files. Verify package contents after a build with stale artifacts present, and ensure workflow/fticket content cannot ship through broad `files: [dist, skills]` globs.
4. Test `ftown sessions`, `ftown harness`, and `ftown env` through the actual temporary-HOME dispatcher and installed launchers, including argument/exit propagation, help discovery, and nonworkflow old launcher compatibility. Stable hook wrapper paths are permitted.
5. Briefing changes must preserve child and parent identity, result/escalation reporting, creator task content and opt-out behavior. Remove lifecycle demands from all generated/authoritative agent-facing surfaces, not merely the briefing string.

Evidence inspected: root coordination contract; `bridge/AGENTS.md`; RTK instructions; skill installer/retirement helpers; workflow and session installers; dispatcher; startup install sequence; child briefing and focused session/orchestrator documentation locations via Semble.

No blocking ambiguity or architecture change requested. Final implementation review pending root handoff. No tests/E2E or Git mutations executed.

## Implementation review

Read the complete application/config/documentation diff and relevant tests, plus the root-run smoke harness. Retirement uses exact shipped signatures and guards real parent directories, preserves customized canonical fticket links, shared runtime files and workflow run data. Startup no longer installs the retired features. Source, package bin and dispatcher routes are removed; build clears stale output. Identity/reporting, task delivery and briefing suppression survive, and authoritative documentation points to grouped commands with explicit cleanup. No new blocking issue found in these simplifications.

Root runtime smoke found an existing main-entry guard defect: `ftown-cli.ts` and `ftown-env-cli.ts` compare Node's resolved module URL against uncanonicalized `process.argv[1]`. macOS temporary paths can pass through `/var` symlinks, causing installed commands to exit successfully without running. Reported to root for bounded worker repair; final approval pending that repair and root runtime evidence. No E2E executed by reviewer.

## Repair closure

Both CLI entry guards now compare the module URL to `pathToFileURL(realpathSync(entry))`, returning false for absent/missing entries. Reviewed both repairs and pure regression tests for physical paths, symlink parents, npm-bin links and import safety. This closes the concrete runtime failure without changing the smoke path to hide it.

Independent code review approved: no unresolved blocking findings. Worker reports 205 focused pure checks passed before the guard repair, then 32 CLI/env checks and final clean build passed after it. These are worker-reported results; reviewer did not rerun tests or use shared runtime resources. Root owns final smoke/full-suite/package evidence and landing decision.

## Final evidence and handoff

Root reports final validation complete:

- Full bridge suite in a sanitized disposable HOME: 772 passed, 4 skipped, 0 failed. Skips: three Windows-only cases and one optional relay case.
- Focused installed-command integration smoke: PASS on the original noncanonical temporary path, six fixture requests; temporary HOME and loopback server cleanup confirmed. Exercises actual installed dispatchers/CLIs against a fixture API, not full native-agent/cloud/browser execution.
- Package dry-run: 243 files at version 0.19.40; no retired feature assets or workflow bin.
- Required live harness status check: read-only PASS; existing process PID unchanged.

No unresolved findings. Code review and concrete repair closure accepted by root. Reviewer has stopped writing and releases the sole `review.md` lease; no Git, build, server, E2E or database lease was held. Ready for task-owned reviewer retirement. Reopen only for actual subsequent code changes or new concrete failures.
