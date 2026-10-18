# Independent review

Reviewer: `/root/npx_review`, explicitly `gpt-6.1-sol` / `high`.
Scope: frozen contract, complete implementation diff, release helper and tests,
and npm release instructions. Read-only except this report; no E2E, server,
CI, publication or Git mutation performed. Root owns packed-npx smoke.

## Source assessment

No blocking source findings. Exact-version lookups distinguish structured
E404 from other failures; existing packages require the current gitHead.
The helper publishes ftown first and resumes only missing packages, derives
both artifacts from one npm-selected payload, and preserves manifests except
for name. Remote release tags are checked before the panel job and again at
publication/tagging. Setup hints retain the intended version.

The helper tests cover missing/same/conflicting versions, registry failures,
partial publication, annotated/lightweight tags, and extracted file/mode/
manifest parity. The implementation handoff reports a passing TypeScript
build, 5/5 release-helper checks including real artifact parity, 4/4 setup-state
checks, read-only preflight and diff whitespace check. Those results were
reused; the reviewer did not duplicate execution.

## Closed finding

- P2, `docs/npm-release.md`, first-publication instructions: state npm's
  verified existing-package prerequisite directly, specify the trusted
  publisher workflow filename as `publish-bridge.yml` (the npm form expects
  the basename), and require permission for direct `npm publish`. New npm
  configurations may otherwise authorize only staged publication. Explain
  that authenticated bootstrap must use the intended final release commit
  and artifacts, after its panel release exists.

Evidence: [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
and [trusted publisher configuration](https://docs.npmjs.com/trusted-publishers/).

Closure: reread the corrected release instructions. They now require first
publication before trust, use the exact `fmktech` / `ftown` /
`publish-bridge.yml` values, require direct publish permission, and place the
matching panel release before authenticated bootstrap from the final merged
commit. The change was confined to documentation; source evidence remains
valid. No unresolved source or documentation findings.

Status: source and documentation review accepted. Root runtime evidence is
outside this review and remains root-owned. Reviewer has stopped writing and
released the exclusive `review.md` lease.
