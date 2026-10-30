# E2E-07 responsive wait repair handoff

Tier 1 `gpt-6.1-terra` / `xhigh`; shared checkout `/private/tmp/ftown-e2e-consolidation`. Changed only `e2e/tests/pending-approvals.spec.ts` and this report.

Hypothesis: the new waiting-state overflow check observes layout immediately after a desktop-to-mobile resize before responsive layout settles. Trace `pending-failed-trace.zip` records viewport change to 390x844 ending at 199504.692 and the exact document-wide overflow evaluation starting at 199509.612 (~5 ms later), returning false. The failure screenshot shows the waiting card and header fitting visibly within the 390px capture; it does not establish the offscreen document width or prove the transient hypothesis. `ui/src/components/PendingDeviceApprovals.tsx` uses a responsive full-width, max-width card with wrapping email text; the trace snapshot shows its enclosing `min-h-dvh p-4 sm:p-8` layout. This is consistent with resize settling, not conclusive evidence against a persistent overflow defect.

Replaced only the waiting-loop immediate assertion with `expect.poll` using the identical `document.documentElement.scrollWidth <= innerWidth` predicate, bounded to 2000ms at 25/50/100ms intervals, matching the existing access-map settling approach. No viewport assertions, other overflow checks, security flows, retries or actions were removed or relaxed. Persistent overflow still fails. `node --check e2e/tests/pending-approvals.spec.ts` and scoped `git diff --check` passed. Root must run the isolated pending reproduction without retries; a failure after settling is evidence of a real unresolved layout issue and should not be hidden. No runtime fix or speed claim is made.

Both write leases released; STOP-WRITE. No install, runtime, server, browser, E2E, CI, database or Git mutation performed.

# E2E-08 account session readiness handoff

Tier 1 `gpt-6.1-terra` / `xhigh`. Changed only `e2e/helpers/account-pairing.ts` and this report. The root's run reported the create-session button disabled beyond the 15-second action budget in account trust and display names, and the requested computer option absent at selection in pending approvals. `createAccountShell` now waits up to 60 seconds for the create button to become enabled, clicks normally, chooses shell type, then polls up to 60 seconds for an option with an exact value match to the requested bridge ID before normal selection. Existing signature, target identity, name entry, create action, Workspace action and session visibility assertion remain unchanged; actual interactions retain the configured action timeout. No global timeout, force, skip or retry was added.

Static `node --check e2e/helpers/account-pairing.ts` and scoped `git diff --check` passed. Root must run all three isolated account specs and check for other causes; no runtime success is claimed. Both write leases released; STOP-WRITE. No install, runtime, server, browser, E2E, CI, database or Git mutation performed.
