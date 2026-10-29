# Session header actions: H1 handoff

- Changed `ui/src/components/Terminal.tsx` and `e2e/tests/session-lifecycle.spec.ts` only. Header content flexes and wraps inside a separate region; the existing action group is a final, nonshrinking sibling anchored at the right padding. Usage can wrap long unbroken model names. Existing actions, handlers, and status behavior are unchanged.
- The existing CRUD lifecycle test now uses a long session name, checks Stop and Rerun geometry at 1280, 900, 390, and 320 pixels, captures header screenshots as test attachments, checks mobile button height and viewport overflow, and triggers Stop with keyboard focus and Enter. Phone Workspace, status transitions, terminal markers, row Stop, and removal checks remain.
- `cd ui && npx tsc --noEmit`: passed. `git diff --check`: passed.
- `cd e2e && npx tsc --noEmit`: failed on cross-project resolution: `@hpke/core` missing, UI `@/lib/*` and `@security/*` aliases unresolved, and resulting implicit-any errors in unrelated imported files. No test-file errors were reported. No dependencies were installed.
- Root reproduction: with the isolated E2E environment configured and verified, run `cd e2e && npx playwright test tests/session-lifecycle.spec.ts --project=chromium --grep 'controller CRUD round-trip'`; inspect the eight `terminal-header-*` attachments and actual mobile/desktop rendering. Runtime and screenshots have not been run or reviewed by this worker.
- Released the `Terminal.tsx`, lifecycle test, and handoff-report write leases. No servers, E2E, browser, CI, dependency installation, or Git mutations were performed.

## H2 dense metadata coverage

- Reacquired and changed only `e2e/tests/session-lifecycle.spec.ts` and this report; `Terminal.tsx` remained frozen. Added `dense session header actions` using a seeded Claude transcript and shell session with a unique working directory and native ID. A live usage GET does not persist; the test stops the fixture through the existing API, polls completed, then fetches and asserts the real usage snapshot before login/open. It checks the rendered token totals and model, then Rerun and Stop geometry at all four widths. Each actual usage/status node must be visible, contained in the header, before the action in DOM and horizontally clear of it. The test performs Stop → Rerun with real status transitions and a terminal marker, and deletes the exact session, transcript, and scratch working directory in cleanup.
- `git diff --check` passed. `cd e2e && npx tsc --noEmit` still reports the same unrelated `@hpke/core` and cross-project alias resolution errors; no test-file errors reported. No browser or E2E execution was performed.
- Root reproduction: focused Chromium grep `controller CRUD round-trip|dense session header actions`; inspect the dense test's eight header screenshot attachments, in addition to the original eight.
- Released lifecycle test and handoff-report write leases. No other files or shared resources were acquired.

## H3 geometry synchronization

- The geometry helper now waits for the button's responsive computed `min-height` (44px below 768px, 32px otherwise) before measuring bounds or capturing screenshots. This waits for the existing CSS transition to settle; all geometry thresholds and assertions remain unchanged. No production files changed.
- `git diff --check` passed. Root owns the focused two-test rerun and review; no E2E or browser was run by this worker.
- Released lifecycle test and handoff-report write leases.
