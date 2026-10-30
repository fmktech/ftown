# Validation

Base9693fbb, feature session-html-preview; runtime in root-owned Boat sandbox bx_3w4mcefk, Node24.22.1, Docker29.7.0. Only local fixture PostgreSQL /ftown and localhost services were used. No production deployment/data or unrelated checkout changed.

## Source and unit checks

- Independent security review: no confirmed blockers; threat model and all15 absence-check items in security-review.md. Independent UI/wiring review and closure in ui-review.md.
- UI: full828-test suite passed before the final UI follow-ups; focused Dashboard/Workspace27 tests and final hook/assembler/workspace9 tests passed after related changes. UI TypeScript and production builds passed on final application source.
- Bridge: build passed. Full1112-test run had1106passes,4 existing skips,2 stale expected-capability assertions; those assertions were updated for the new preview flag and the entire local-api-server test file passed. Preview-specific forced interleavings and encrypted permission/archive checks passed. Full updated suite will run in CI.
- Release artifacts:17tests passed. Source diff whitespace check and commit gitleaks passed. Bridge version0.19.61.
- Standalone E2E tsc still reports existing alias-resolution/implicit-any errors in unchanged account-trust-store.ts and device-display-name-store.ts; no new preview spec/helper errors. Compiler configuration unchanged. UI tsc/build is green.

## Root runtime evidence

`ftown harness status` reported the task-owned bridge up. Root executed `npx playwright test tests/session-preview.spec.ts --project chromium` against the real production UI and bridge. Final run process40891/command cmd_mzzdte6nfxrj:2passed in17.2s (desktop14.0s,mobile2.7s).

Coverage: real CLI register/clear; cloud and local encrypted reads; >96KiB chunk-boundary UTF-8; interactive script/dataimage; unchanged polls preserve state, atomic same-size edits reload/reset; manual refresh; per-session isolation; close/edit/reopen/new registration; missing/recovery; size/path/symlink rejection; session/archive privatepath redaction; iframe parent/storage/ordinary network restrictions and no plaintext preview in broker capture; desktop split/pointer/keyboard resizing, mobile and compact tabs, terminal identity, no overflow and44px targets.

The first mobile run failed the44px touch-target assertion (40px); CSS repaired and the same assertion passed. Rendered review found periodic unchanged-check Updatingoverlay; hook now shows it only on manualrefresh or actual newrevision download, with red/green controlledpromise regression and final E2E pass. No browser assertions weakened. Root inspected final desktop, mobile and compact-desktop screenshots: split placement, filename truncation, toolbar targets, compact tabs and page overflow are correct. The broken-image label in the fixture is the intentional blocked network probe, not an application asset failure. Artifacts are preserved under /Users/fkesheh/.codex/task-artifacts/ftown-html-preview/.

## Compatibility and limits

Single self-contained UTF-8 HTML, <=1MiB, inside explicit session working directory. Inline CSS/JS and dataimages only; no sibling asset service or feedback channel. Atomic rename is recommended for completed publications. Sandbox with opaqueorigin blocks dashboard DOM/storage access and ordinary resource loads, but is not blanket network/CPU isolation (self-navigation possible). Trusted local OS registrant and ordinary symlink protection, not a claim of malicious same-UID race immunity. See usage.md/security-design.md.

CI status and final cleanup are recorded in the PR after submission to avoid unnecessary source-only CI reruns.
