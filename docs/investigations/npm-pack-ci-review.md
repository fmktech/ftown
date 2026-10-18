# npm JSON compatibility review

Reviewer: `/root/npx_review`, explicitly `gpt-6.1-sol` / `high`.
Checkout: `/Users/fkesheh/projects/ftown-simplify-all`.
Scope: repair diff, dedicated PR workflow, original frozen publication contract,
and dated investigation/handoff. Read-only except this report.

## Findings

No unresolved findings. Both pack call sites now accept the observed singleton
npm11 array or npm12 package-name map. The shared parser requires exactly one
matching package/version and the expected safe tarball basename; malformed,
ambiguous and mismatched records fail closed.

Successful exact-version registry responses accept either one object or a
singleton array, validating the requested name and version. Nonzero status is
handled before normalization, so only the existing structured E404 exception
means absent. Existing source gitHead, publication order, partial retry and tag
guards remain intact. Package/lock versions both advance to 0.19.43 with bins
and dependencies unchanged.

The new pull-request workflow installs npm11 and npm latest on Node24 in
separate matrix jobs, then runs the actual install, build and release-helper
tests. Child npm commands inherit the installed toolchain. Permissions are
read-only and the workflow contains no publication or runtime/E2E commands.
The retained real artifact check verifies files, modes and normalized
manifests; new cases discriminate the observed schemas and invalid results.

## Evidence and acceptance

Reused the implementation handoff: original npm12 failure reproduced while
npm11 passed; repaired TypeScript build passed; all 7 release tests, including
real artifact parity, passed under npm11.6.2 and isolated Node24.15.0/npm12.2.0.
Real npm12 exact-version metadata for 0.19.41 and missing-version E404 responses
for both 0.19.43 packages were accepted as intended. Diff whitespace check
passed. See `2026-10-18-npm-pack-json.md` for reproduction and handoff details.

Source and regression-check design accepted. No duplicate execution, server,
setup, E2E, CI, publication or Git mutation performed by this reviewer. Root
owns landing and automatic CI verification. Reviewer stopped writing and
released the exclusive report lease.
