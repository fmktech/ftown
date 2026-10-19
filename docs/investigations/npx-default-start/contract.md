# Canonical npx startup and release detection

2026-10-18. User expects `npx ftown` to behave like `npx ftown-bridge` and questions the long generated bootstrap command. Published metadata currently points both names to 0.19.44, while main is 0.19.47. PR121 is merged.

## Frozen behavior

- `ftown` with no arguments starts the bridge through existing `runStart` and its setup-readiness gate. Root startup options, such as `--local`, `--api-url` and `--solo`, pass unchanged to the same start route. Explicit `ftown start ...` remains supported.
- `--help`, `-h`, and `help` continue to print canonical CLI help without setup checks or startup. Existing setup/sessions/harness/env groups retain behavior. Unknown positional subcommands remain errors. Do not silently install or modify integrations during ordinary startup.
- Help describes bare/default startup. First-time setup stays explicit, with short `npx ftown@VERSION setup` guidance.
- Dashboard displayed and copied commands share one canonical command builder: `npx -y ftown@latest setup && npx -y ftown@latest --api-url <quoted current origin>`. Solo example uses the same package/start convention with `--solo`. Preserve clipboard fallback and existing UI layout. Shell-quote any interpolated origin.
- Fix release change detection independent of process cwd. `changedPackageFiles` must return identical root-prefixed classified paths when invoked from repository root or `bridge/`, using Git's root-anchored pathspec and `--no-relative` so local Git configuration cannot strip the prefix. Keep all existing filtering/versioning/publication guards. Do not dispatch publication or merge this PR.

## Boundaries and acceptance

No new dependencies or auto-setup flow. One shared checkout. CLI/UI writer also owns integration/Git/package version and lockfile. Release writer owns only the classifier and its test; temporary Git repositories created by the regression are isolated unit fixtures, never this checkout's index/history.

Focused tests cover default startup, root option forwarding, read-only explicit help, unknown subcommands, generated displayed/copied command consistency, current origin quoting and Solo form. Release regression uses real temporary Git history and compares root vs bridge cwd, including excluded test/docs paths. Root executes real package/copied-alias startup with isolated HOME and local-only bridge, required harness status, and relevant focused E2E. Workers run isolated units/static checks only, never E2E/servers/CI reruns. Integration bumps patch version to 0.19.48, builds, validates release artifacts, commits/pushes authorized files and opens PR against main after review/runtime gates. Four unrelated dirty investigation notes remain untouched.

Read-only findings: /root/canonical_start identified dispatch/UI sites; /root/npx_review proved root sees 17 classified runtime paths while bridge cwd sees zero for the same actual PR121 commit range. Publish run 39155308433 reported success while package preflight/panel/npm jobs were skipped. The release fix belongs in this deliverable because otherwise corrected CLI behavior never reaches npm.
