# Idle push follow-up integration

Integration and independent review owner: native `/root/npx_implementation`,
explicit `gpt-6.1-sol` with `high` reasoning effort. Shared checkout:
`/Users/fkesheh/projects/ftown-simplify-all`. Exact ownership and serialized
resources are recorded in `/tmp/ftown-push-followup/coordination.json`.

Branch `fix/idle-push-after-ten-minutes` starts from main
`cb6406890217f2b7bbeb3399300c4c307839e491`. Four older modified investigation
notes are unrelated and must remain unstaged. No other worker's edits were
reverted. Root owns all runtime/E2E execution and production operations.

## Independent review

Reviewed the frozen contract before implementation and the final stopped-source
handoff afterwards. No unresolved findings. Checked:

- Persisted UUID and deadline survive restart; repeated idle preserves the cycle,
  initial/legacy idle does not arm, and notified cycles do not replay. Qualification
  is durably recorded before the callback; `occurredAt` is emission time.
- Thinking/tool use, SessionEnd, terminal/removal and shutdown cancel pending
  work. SessionEnd's idle classification cannot accidentally create a new cycle.
  Cancellation runs before queued locks and again inside the session lock.
- Async live-session, token and persistence continuations recheck cancellation;
  matching in-flight bridge fetches abort best effort. Questions retain immediate
  queue eligibility during an idle retry backoff.
- Actual `CentrifugoClient.publishSessionUpdate` emits `session_update` on
  `sessions:updates#USER`; removal publishes the same shape with `removed` status.
  The index observer matches these production shapes rather than an invented
  lifecycle event. Live-session eligibility is checked again at timer emission.
- One missing/corrupt restoration ledger is isolated without rewriting corrupt
  history or aborting startup. Known-running non-shell sessions alone are restored.
- Cloud parsing accepts rolling legacy `idle` and new `idle:UUID`; existing
  owner/bridge/session identity and durable dedup remain unchanged. A later cycle
  has a different identity. No schema or cloud cancellation protocol was added.

The already documented limits remain: a crash after durable qualification but
before best-effort delivery can lose a notice; provider delivery already handed
off cannot be recalled.

## Version and checks

After source writer `/root/npx_review` stopped and released its files, fetched
origin: main still declares `0.19.45`; read-only npm canonical latest returned
`0.19.44`. Applied one required patch bump to `0.19.46` using
`npm version patch --no-git-tag-version`. Lock changes contain only the two
matching root version fields; dependencies are unchanged.

- Bridge build passed at `0.19.46`; generated-output writing completed.
- Source worker focused evidence: bridge 19/19, UI 15/15, both TypeScript no-emit
  checks and diff whitespace check passed (see implementation.md).
- Full bridge `npm test`: 808 passed, 4 skipped, 0 failed (812 tests).
- Full UI `npm test`: 309 passed across 37 files, 0 failed.
- `git diff --check` passed. No worker E2E, external publish or CI run was requested.

Root's final runtime gates passed: UI production build, focused push Playwright
2/2, and scratch installed bridge `0.19.46` setup/start plus `ftown harness status`.
The E2E covers distinct idle cycles and same-cycle dedup with real authenticated
API/SQL, plus service-worker/UI behavior. Provider/OS boundaries are simulated;
no real ten-minute wait or external push-provider delivery was tested.

Root removed task compose resources, scratch HOME/certificates/process markers
and confirmed test ports free. Docker Desktop was restored to its initially
stopped state; unrelated containers/data were preserved. Separate VAPID setup
completed without repository secrets; activation requires the next production
deployment. This PR does not deploy, migrate, merge or publish packages.

## Accepted handoff

Implementation and operations workers are accepted, native completed and no
longer writing. All review findings are closed. Root authorized Git landing after
the gates above; fresh origin/main remains the original `.45` base, so `.46` has
no main-version collision. Only the exact task allowlist is staged, with the four
unrelated notes preserved. Integration stops writing and releases its remaining
Git/report leases at the PR handoff; no further build/test runs are needed.
