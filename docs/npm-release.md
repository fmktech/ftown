# npm releases

Fresh setup uses `npx ftown setup`. The `ftown` and `ftown-bridge` npm packages
contain the same CLI, dependencies, bins and bundled assets. Their manifests
differ only in `name`; both retain the canonical `ftown` command. The source
package stays named `ftown-bridge` for existing integrations and bridge starts.

Every change to bridge runtime, shipped assets or build inputs needs a new version in both `bridge/package.json`
and `bridge/package-lock.json`. Tests, agent docs and external release tooling
do not require a package version or publication; the shared
`scripts/release/package-changes.mjs` classifier gates both bump checks and
automatic publication. Explicit workflow dispatch remains available for release
recovery. The publish workflow on main checks both exact
npm versions and the `bridge-vVERSION` tag before cutting the panel release.
Only npm's structured E404 is treated as absence. Registry authentication,
network and unexpected response errors stop the release.

An existing version must have a `gitHead` matching the workflow checkout.
Otherwise bump the version and merge again. A same-commit retry skips packages
that already exist, publishes the missing packages in `ftown`, `ftown-bridge`
order, then creates the release tag. An existing tag is accepted only when it
resolves to that commit. This permits recovery when only the first package was
published. A manual rerun must select the same commit as the original release.

## First publication and npm authorization

An authorized npm maintainer must confirm control of the `ftown` name and
perform its authenticated first publication: npm requires a package to exist
before its trusted publisher can be configured. Availability of the name does
not grant this repository publishing permission. See the
[npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

Bootstrap from the intended **final merged commit**, build and pack from that
checkout, and retain its exact `gitHead` in the public artifact. Publish the
matching panel release **before** publishing the public `ftown` artifact, so
users can start solo mode immediately. A workflow retry at that same commit
then recognizes the bootstrap version and publishes any missing compatibility
package. Never bootstrap from the PR branch commit when it differs from the
eventual merged commit.

Configure npm trusted publishing **separately for both packages** using the
[GitHub form](https://docs.npmjs.com/trusted-publishers/) values: organization or
user `fmktech`, repository `ftown`, and workflow filename `publish-bridge.yml`
(the basename, without `.github/workflows/`). Match the GitHub environment if
one is configured. The workflow requires npm >=11.5.1, `id-token: write`, and
provenance support. A trusted publisher for `ftown-bridge` does not authorize
publication of `ftown`.

Grant direct `npm publish` permission, rather than only staged publication;
the [CLI permission flag](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
is `--allow-publish`. No live npm publication is needed to validate or review
these repository changes.

## Release helper and local verification

From repository root, the internal helper provides these commands:

```bash
npm --prefix bridge run build
node --test scripts/release/*.test.mjs
node scripts/release/publish-packages.mjs preflight
node scripts/release/publish-packages.mjs pack /absolute/path/to/artifacts
```

`preflight` reads registry metadata and the remote tag without publishing. It
prints the plan and writes `version` to `GITHUB_OUTPUT` when set. `pack` needs a
built package, writes both tarballs to the supplied directory, and prints their
paths. It selects the canonical npm payload once, records the source `gitHead`,
then repacks it under each name. The artifact test compares every extracted
file and its mode, normalizing only the package name.

The workflow alone runs `publish` after the panel release and `tag` after both
packages exist. These commands repeat the registry/tag checks; `publish` uses
the tarballs with scripts disabled because the build and parity checks already
ran. `tag` refuses to proceed while either package is missing.

For a local setup smoke, use `npx --yes file:/absolute/path/to/ftown-VERSION.tgz setup`
from a temporary working directory with a fresh temporary HOME, USERPROFILE and
npm cache. This exercises npm's `ftown` bin inference without publishing. The
setup writes integrations to that HOME, so keep this environment isolated.
Readiness and upgrade hints pin the intended version as
`npx ftown@VERSION setup`; append `--repair` for an incomplete current setup.
