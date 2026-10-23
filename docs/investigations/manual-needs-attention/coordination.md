# Manual needs-attention section

User request: add an upper sidebar section like the supplied reference, initially using existing manual-input requests and retaining sessions in their original view.

Shared checkout: `/Users/fkesheh/projects/ftown-simplify-all`. Branch: `feat/manual-needs-attention`. Base: `9f44fccbfd8ec6cb2a5a0805717d540fa9c4a9f6`. The four pre-existing dirty investigation notes are excluded; the Git owner recorded their hashes in `/tmp/ftown-manual-attention-notes-before.json`.

## Contract

- Derive rows from `SessionList`'s visible sessions and existing `SessionActivity.attention`. Include only existing manual notices, never idle state alone. Exclude hidden sessions and hidden bridges. Children in collapsed bridge/folder/parent groups remain eligible.
- Place a compact `Needs attention` section before bridge groups, only when nonempty and the sidebar is expanded. Keep original rows and existing toast/dismissal behavior. No APIs, new state persistence, subscriptions or dependency changes.
- Order by newest `receivedAt`, preserving incoming order for ties. Reuse current session display-name fallback and `HarnessIcon`. Show a subtle attention indicator and request age, selected background, truncation, and accessible full request text. Native buttons with visible keyboard focus and at least 44px height call only `onSelectSession(id)`. Preserve Dashboard's existing clear-on-selection and mobile navigation behavior; do not add an independent dismissal handler.
- Reuse existing design colors and sidebar spacing. Keep rows compact even when selected. No duplicate drag handles, inline rename, context menu or nested expanded details.
- Existing hook clears/removal/hidden-state updates remove shortcuts naturally. Empty state consumes no sidebar space.

## Ownership and execution

Root owns this contract/manifest, scope decisions, CI/E2E/browser execution, runtime selectors, screenshot review and cleanup. All workers use explicit `gpt-6.1-sol` / `high`, one shared checkout, no subdelegation. Implementation owns exactly the four files in `ownership.json`; reviewer is read-only; `/root/npx_implementation` is the only Git/index/landing owner. No parallel source writers, installs or generated outputs.

Read-only discovery `/root/attention_discovery` completed and released resources. Git preparation completed with clean index and unrelated notes unchanged. Independent reviewer `/root/npx_review` approved the contract; its correction about Dashboard's existing clear-on-selection behavior is incorporated above. Idle activity WITH manual attention remains eligible. All six owned paths passed equal/ancestor collision validation. Contract frozen for implementation; implementation/review native IDs are recorded in the manifest at dispatch.

Acceptance: focused rendered-component regressions for duplication, ordering, visibility/collapse, selection and clearing; real browser event injection through the scratch bridge, selection/clear and desktop/mobile layout screenshots. Root runs CI with its existing isolated local Postgres/Neon shim, Centrifugo and scratch HOME; no production selectors. Preserve success screenshots by making the existing Playwright artifact upload unconditional. UI unit/build and existing E2E suite also run in that workflow. Main-only deployment workflows must not be triggered.

Mac sampled with growing swap (3,620 pages in one second) and load 14.19; heavy builds/tests stay on GitHub Actions. No local servers or cloud sandboxes are acquired. Lightweight focused unit/static checks may run with bounded concurrency. Final independent source review and root visual/runtime acceptance precede completion; open a PR without merging.

## Implementation handoff

`/root/attention_implementation` (explicit gpt-6.1-sol/high) completed exactly the four assigned files and stopped writing. Focused component tests passed 12/12; UI and E2E TypeScript checks passed with incremental output disabled. Desktop 1280x900 and mobile 390x844 browser cases use real scratch shell sessions and `/hook`, asserting original retention, eligibility/order, correct-terminal selection, existing clearing, hide/unhide, keyboard focus, 44px targets, and no horizontal overflow. Each attaches a PNG for root visual review and removes only its own created sessions in `finally`. No worker started services, E2E, CI, installs or Git operations.

Root inspected CI selectors before execution: `e2e/env.sh` uses `postgresql://ftown:ftown@localhost/ftown`, localhost Centrifugo and the CI-owned Neon shim; Compose creates isolated runner services; `start-services.sh` uses `e2e/.bridge-home` and only recorded PIDs for cleanup. No production deployment workflow is selected. `/root/npx_review` independently approved the four-file final diff with no blockers and stopped without leases. Git owner is authorized to commit/push the six task files, with root then dispatching the existing E2E workflow on this branch. Runtime and screenshot acceptance remains outstanding.

## Accepted runtime and visual evidence

Root dispatched [E2E run 39989351131](https://github.com/fmktech/ftown/actions/runs/39989351131) on source commit `ab4ab965eb4006ba317f532ceceff886c3f6ea46`. The run passed UI build and 349 UI tests, bridge build/tests, release and managed-Solo checks, and 40 Playwright tests (two existing skips). Both new attention scenarios passed against real scratch bridge hooks: desktop and mobile. The UI/bridge stop, artifact upload and Compose teardown steps all succeeded.

Root downloaded the success artifact to `/tmp/ftown-attention-validation-aQAIHS/report` and inspected both `needs-attention-desktop.png` and `needs-attention-mobile.png`: compact section above the original groups, duplicated originals retained, readable icons/ages, long-name truncation, visible keyboard focus, and no horizontal overflow. Browser assertions also verified correct terminal identity, mobile navigation, existing clear-on-open, hide/unhide and hook resolution. Runtime and visual acceptance passed; no source repairs were needed.

Discovery, implementation and review workers are completed with no write leases; native completion status was verified. No task-owned local services or cloud sandboxes exist. Git owner has the sole remaining bounded publication assignment: commit these evidence updates, push and open the PR; its final native handoff records the PR URL/head and lease release. Preserve the four unrelated dirty notes. Reuse this valid runtime evidence for unchanged source; automatic PR checks may run again. No merge or production deployment is authorized.
