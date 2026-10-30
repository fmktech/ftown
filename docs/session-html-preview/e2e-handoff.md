# E1 focused acceptance authoring

Owner `/root/auth_review`, Tier 2 `gpt-6.1-sol` / `max`, shared `/tmp/ftown-html-preview`. Writable scope only `e2e/tests/session-preview.spec.ts`, `e2e/helpers/session-preview.ts`, and this report. Root exclusively runs services/E2E/CI. No other account/fixture environment is mutated; the virgin MCP account is not used.

## Test design before implementation

| Edge taxonomy | Planned contract checks |
|---|---|
| Empty/missing | No registration leaves terminal layout; missing registered file hides old frame and recreating it recovers; clear removes descriptor |
| Boundaries | Document over one 96KiB chunk, Unicode crossing the exact byte boundary; >1MiB registration rejected; desktop split/240px minima and compact/mobile fallback |
| Invalid input | Traversal/outside-root and final symlink registration rejected; crafted head/base/meta cannot weaken fixed renderer policy |
| Dependency failure | Missing file/recovery; ordinary iframe fetch/image/script destinations are intercepted locally if policy fails so tests never depend on external network |
| Concurrency/ordering | Atomic replace changes a same-size document; closed pane and session switches do not commit another target's content |
| Idempotency/repetition | Unchanged polls preserve JS counter; manual refresh resets; Close does not clear registration; a new registration ID auto-opens once |
| Unicode/encoding/time | Real UTF-8 chunk-boundary assembly; await actual observed status/DOM changes rather than fixed poll sleeps; unique fixture names do not affect assertions |

Mutation discrimination: missing chunk concatenation/UTF-8 handling loses the emoji assertion; skipped revision updates keep old version/counter; remount on every poll loses the counter after observed unchanged; shared visibility/bytes leaks another session; permissive sandbox/CSP triggers parent/storage or intercepted local probes; missing wire sanitizer exposes previewSource/full source file path; missing confinement accepts outside-root/symlink fixtures.

U1 confirmed accessible names: iframe `HTML preview: <fileName>`; preview container `aria-label="Session preview"` (region in split, tabpanel when compact); controls Open preview / Close preview / Refresh preview; separator Resize terminal and preview; tabs Terminal / Preview.

## Authored cases and fixtures

- `session-preview.spec.ts`: two coherent cases. Desktop uses two owned shell sessions to exercise real CLI registration, shared cloud RPC and encrypted local dashboard retrieval, inline JS/data image, observed unchanged polls preserving JS state, >96KiB UTF-8 boundary, equal-size atomic edits resetting state, manual Refresh, drag/keyboard separator, Close/edit/reopen/new registration, per-session visibility, missing/recovery, outside-root/symlink/oversize rejection, clear and registered-session archive sanitization. Mobile uses one owned session for Workspace/Terminal/Preview navigation, terminal node preservation, touch controls, no page overflow, and the <640px available-main compact fallback after widening the sidebar.
- `helpers/session-preview.ts`: validates canonical fixture URL/HOME/DB before writes; creates unique workdirs only below BRIDGE_HOME; invokes the actual dist CLI with HOME/FTOWN_SESSION_ID and a session cwd; writes temporary HTML then atomically renames; cleans only its own sessions/directory. Public session/archive checks deliberately permit the existing workingDir field while rejecting previewSource and the full new HTML file path.
- Passive browser observation retains native crypto/auth results and emits only bounded preview state/offset metadata to the test. Ciphertext frames/local envelope requests are checked for plaintext fixture markers. No production auth bypass or alternate viewer is introduced.
- Crafted preview markup attempts permissive head/meta/base, removal of the first CSP element, parent DOM, localStorage, fetch, external image and script. Probe destinations are canonical localhost routes intercepted by the test if policy fails, so the negative case never depends on arbitrary external services. This proves ordinary paths, not CPU/self-navigation isolation.
- Artifacts: `preview-desktop.png`, `preview-mobile.png`, `preview-compact-desktop.png` are attached by the spec for root's rendered review.

## Checks and root execution

Node24.22.1 `--check` passed for both new TypeScript files. Whole-e2e `tsc --noEmit --project e2e/tsconfig.json` could not analyze source in this checkout: TS2688, missing `@types/node` under e2e dependencies. No dependencies or compiler settings were changed. No browser/E2E/service/CI command was executed by E1, and actual mutation runs remain root-owned.

Root prerequisites: built UI/bridge with the combined changes; canonical isolated services and selector preflight; explicit local `/ftown` database and canonical `.bridge-home`; the normal shared E2E account; installed e2e dependencies; browser trust; no reuse of the virgin MCP fixture. Root command from e2e: `npx playwright test tests/session-preview.spec.ts --project chromium`. Typecheck first in the prepared sandbox. Expected: 2 passes, three attached screenshots, cleanup of the three test-created sessions and unique fixture directories, no forbidden probe requests, and no plaintext preview marker/source field on captured transports.

Lease release: all three E1 files are ready and E1 has stopped writing. Remaining limitations: runtime/type API compatibility is pending root's installed-dependency checks; restart persistence and low-level stale read interleavings are covered by B1's unit tests rather than restarting the shared bridge from this focused spec. Root may return concrete failures for repair within the same ownership.

## E2 role alignment

Root expanded ownership narrowly to Workspace/Terminal role selectors in account-pairing, session-lifecycle, session-needs-attention, new-session-navigation, account-trust, session-tools, automation-sunset and capture/product. The 21 old button-role queries across these files and the new preview spec now query tab, matching the actual Dashboard semantics. Class and behavior assertions are unchanged. No application/config edits or E2E execution were performed. These repair leases are released.
