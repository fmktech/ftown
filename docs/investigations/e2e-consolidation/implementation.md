# E2E-04 implementation handoff

Tier 1 `gpt-6.1-terra` / `xhigh`; shared checkout `/private/tmp/ftown-e2e-consolidation`. Changed only `e2e/tests/account-trust.spec.ts`, `e2e/tests/pending-approvals.spec.ts`, and this handoff. No contract or helper changes.

Each spec now defines one desktop/mobile journey instead of two complete viewport variants (expected Playwright list delta: -2 tests; no changed skips). Account retains desktop bootstrap, mobile second-computer pairing, desktop approval plus mobile retry after committed response loss, both actual reconnects, stale-tab and cloud terminal checks, the full pending access-map matrix, and mobile revoke. First-device Access, approval comparison, and removal confirmation render at both widths with distinct screenshot paths. The automatic journey keeps desktop and mobile landing/waiting/review evidence, executes bootstrap, review/approval and reject on mobile, retains browser admission and CLI cancellation paths, and renders the computer review at both widths before desktop confirmation. Existing cleanup and failure propagation remain intact. Named steps attribute major phases without putting private data into step names.

Static checks: `node --check` on both TypeScript specs passed under Node v24.12.0; `git diff --check` passed. Local dependencies and TypeScript compiler are absent; no browser, server, database, install, CI, or Git mutation was run. Syntax checks do not establish types or runtime behavior. Root owns e2e `tsc --noEmit`, fixture guard, Playwright list, visual evidence, timings, and focused browser execution:

```sh
npx playwright test --project=chromium-isolated tests/account-trust.spec.ts tests/pending-approvals.spec.ts
```

Primary remaining risk: live viewport transition and modal/action behavior requires the root's isolated browser run and screenshot inspection, including 900x760 with a pending row. No performance outcome is claimed before measurement. All three file write leases released; STOP-WRITE. No process or shared resource lease acquired.
