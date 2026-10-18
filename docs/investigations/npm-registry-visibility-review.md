# Registry visibility review

Reviewer `/root/npx_review`, explicitly `gpt-6.1-sol` / `high`, reviewed the
bounded helper/test/version repair and investigation in the shared checkout.
No unresolved findings.

Only tag verification waits on exact-version E404 absence. Confirmed records
are cached; gitHead collisions, malformed metadata and other registry errors
retain failure behavior. The wait cannot publish packages, and the remote tag
is checked before waiting and again before pushing. Preflight and publication
behavior remain unchanged. Package and lock both advance to 0.19.44.

The initial deadline concern is resolved: remaining time is checked before
and after each lookup, the tag-only npm subprocess receives its remaining
budget, and expired requests terminate with same-commit retry guidance. The
regressions cover delayed visibility, caching, clamped sleeps, slow lookup,
no request after expiry, remaining request budgets, timeout and immediate
error propagation.

Reused worker evidence: build passed, 13/13 release checks passed on npm11.6.2
and isolated Node24.15.0/npm12.2.0, including real artifact parity; whitespace
check passed. Root owns production recovery, runtime and automatic CI evidence.
No duplicate tests, E2E, setup, servers, CI, publication or Git actions were
performed by this reviewer.

Accepted. Reviewer stopped writing and released this report lease.
