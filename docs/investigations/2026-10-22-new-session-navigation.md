---
type: investigation
symptom: "Creating a session with the UI + button does not open it"
slug: new-session-navigation
date: 2026-10-22
git_commit: 5b3a8c1859fa03dbc871e0ede39bcd04708401ef
branch: fix/open-newly-created-session
status: resolved
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

## Symptom

User: "I mean I go in the UI + button, start a new session but I dont navigate imediatelly to it"

Observed: a successful creation closes the modal but leaves the existing selection (or empty panel). Expected: open the exact newly created session immediately after success, including the mobile terminal tab.

## Reproduction

Open the dashboard with a connected test bridge. Click +, choose Shell, name the session, and submit. Without clicking a session row, inspect the main terminal and mobile active tab. Browser coverage will exercise desktop and mobile. Before source changes, `cd ui && rtk proxy npm test -- src/components/Dashboard.test.tsx src/hooks/useSessions.test.ts` reproduced the defect: exit 1, 5 failed / 53 passed. Four desktop/mobile × hosted/local cases failed with `expected 'ordinary' to be 'created-id'` at Dashboard.test.tsx:134 even when session metadata was already present. The hook test failed with `expected undefined to deeply equal { id: 'created-id', ... }` at useSessions.test.ts:333. Failure-preserves-selection passed.

## Hypotheses

### H1: The create-success path discards identity and never selects the session

- Layer: code logic.
- Prediction: even a successful response containing a session cannot change the selection.
- Verification: inspect create callback and hook; reproduce with a component test before editing source.
- Evidence: `Dashboard.tsx:305–311` awaits `createSession(prompt, options)` then only calls `scheduleTerminalRenderAdjustment()`. `useSessions.ts:101–103` declares `Promise<void>` and `:416–420` checks success but discards `resp.data.session`. `Dashboard.tsx:357–363` already provides selection plus mobile navigation.
- Verdict: PROVEN. The deterministic pre-fix regression preserves the old selection despite a successful reply and available new row; hook regression separately proves the reply is discarded.

### H2: Bridge create success does not supply the new session identity

- Layer: integration.
- Prediction: there is no precise session target in the response.
- Verification: inspect bridge response and local adapter.
- Evidence: `bridge/src/command-rpc.ts:105` returns the created wire session; `ui/src/lib/local-browser-client.ts:100–112` carries the command response into the shared RPC path.
- Verdict: REJECTED. Both transports provide the result needed for selection.

### H3: The session list event automatically navigates but arrives too late

- Layer: state/data.
- Prediction: once a publication inserts the row, selection changes without an explicit success handler.
- Verification: inspect selection state writers and public session-update handling.
- Evidence: `Dashboard.tsx:266` derives the selected row from `selectedSessionId`; list/publication handling in `useSessions` only updates rows. The create handler has no selection write at all.
- Verdict: REJECTED. Row arrival alone does not select it.

## 5 Whys

1. The user remains on the previous panel because successful creation does not select a session.
2. The dashboard callback only refits the terminal.
3. The hook promises completion without returning the created session.
4. Creation state relies on asynchronous publications, separate from user navigation intent.
5. The create-success contract never connected the authoritative result to navigation, and tests that manually open a sidebar row conceal that missing behavior.

## Falsification

The backend/local transport alternative was checked and rejected: both return session identity. The failing component regressions supply both the created row and an unrelated newer row before success, while starting from an existing selected session. All desktop/mobile and hosted/local variants still leave `ordinary` selected. This isolates the missing success transition from row arrival and platform differences. The hook regression separately isolates reply-before-publication ordering. The hypothesis survived these checks.

## Root cause

Creation resolves only completion, discarding the authoritative session, and its caller never invokes the already available selection transition. This contract gap is independently confirmed by source and failing regressions. Backend identity availability and delayed list arrival were rejected as causes. Existing E2E helpers manually open created rows, concealing the missing automatic transition.

## Frozen contract and ownership

Implementation owner `/root/npx_implementation`, model `gpt-6.1-sol`, effort `high`, shared checkout `/Users/fkesheh/projects/ftown-simplify-all`. Reviewer `/root/npx_review`, same explicit model/effort, read-only. Root owns this artifact and all E2E execution/resources. No other writers.

Exclusive implementation files:

- `ui/src/components/Dashboard.tsx`
- `ui/src/components/Dashboard.test.tsx`
- `ui/src/hooks/useSessions.ts`
- `ui/src/hooks/useSessions.test.ts`
- `e2e/tests/new-session-navigation.spec.ts`

Expected export change: `useSessions().createSession` resolves to the validated created `Session`. Reconcile the returned row before resolution, preserving newer observations, tombstones, and account/context boundaries. Reject unsuccessful/malformed/stale responses without navigation. Dashboard calls existing `handleSelectSession` with this exact result, retaining error display and prior selection on failure. Both hosted and Solo use this shared path. No backend changes, generic navigation framework, dependency changes, or new automatic selection from background events.

Acceptance: immediate desktop/mobile opening without sidebar click; exact identity with existing sessions; delayed/early publications and stale lists do not duplicate/remove/regress the created row; unsuccessful creation preserves selection and modal error flow. Independent contract review completed before source changes. Initial lease allows regression tests only until the debug gate passes. Implementation worker owns Git operations; no commit/push until root accepts review and focused runtime evidence. Preserve four pre-existing dirty investigation notes byte-for-byte.

Root E2E leases: task-only Compose project `ftown-session-navigation`, free local ports 443/5432/8000/3000, scratch `e2e/.bridge-home`, generated certs/build/test artifacts and PID files. No existing FTown E2E processes were found; unrelated Docker projects remain untouched. Database selector must resolve to the task Postgres (`localhost:5432`, database/user `ftown`) before schema setup; app auth/database/Centrifugo selectors use `e2e/env.sh`. No production resources or real agent CLIs.

Ownership validation: root mechanically checked all six file leases for equal/ancestor path overlaps; PASS. Source release occurred only after test-only reproduction. Independent reviewer also verified that bridge 0.19.44 returns the same core session response; no bridge upgrade is required.

E2E preparation: root verified effective Compose configuration, started only `ftown-session-navigation`, and queried its Postgres to confirm `current_database=ftown/current_user=ftown` before `setup-db.mjs` with explicit localhost:5432 selectors. No UI environment files or parent deployment/database selectors are present. Existing E2E logs/reports were moved into `/var/folders/ft/gvw3pk8x1w7g7cxhzj50ptyh0000gn/T/ftown-navigation-artifacts-v6hl98fk` for restoration; certs, scratch HOME, PID files and run-email were absent before this run.

## Validation and handoff

Red regression completed before source edits (5 failures / 53 passes). Source gate released only after this evidence was recorded.

## Resolution

- `useSessions.createSession` returns the validated, reconciled created row, retaining existing publication/list/tombstone/context protections. Dashboard selects the returned ID through its existing handler; mobile switches to Terminal. The shared local/hosted component path and existing failure flow remain intact.
- Focused unit regressions: **70/70 passed**, including desktop/mobile × hosted/local, exact identity, failed creation, reply/publication ordering, stale lists, newer state, tombstones and account/unmount responses.
- Full UI unit suite: **343/343 passed across 37 files**. UI and E2E TypeScript checks passed; scoped diff check passed. Root production Next build passed, with existing metadata/themeColor warnings.
- Independent source/unit review found no material issues. Reviewer requested strengthening the mobile browser spec to start from Workspace; the same worker exclusively reacquired that test file, made the change and released it after typecheck. No source change or rebuild was needed.
- Root executed the real hosted Playwright flow: **2/2 passed in 3.7 seconds**, desktop and mobile, without clicking the created session row. Exact terminal header, working terminal input/output, existing session remaining running, unchanged browser page/URL, and mobile Workspace-to-Terminal navigation were verified.
- Root inspected both browser screenshots: the new session terminal is visible and usable; mobile Terminal is active. Evidence is retained at `/var/folders/ft/gvw3pk8x1w7g7cxhzj50ptyh0000gn/T/ftown-navigation-artifacts-v6hl98fk/verified-run`.
- The initial browser attempt failed before reaching the app (`ECONNREFUSED`) because the exec runner ended the background service group. Keeping startup and tests in one exec lifecycle yielded both passes. Its relative cleanup trap then returned 127 after the tests had passed; root separately ran the absolute cleanup script and verified both recorded processes were stopped. No application or assertion changes were needed for either orchestration issue.
- Cleanup verified: task Compose containers/network removed, ports 443/5432/8000/3000 free, scratch HOME/certs/run-email removed, prior E2E logs/reports restored. Other Docker projects and real bridge/session state were untouched.
- Implementation/source leases released; reviewer read-only work complete. Git owner may now commit exactly the five implementation files plus this investigation and open a PR; preserve all four unrelated notes. PR publication does not authorize merging.
