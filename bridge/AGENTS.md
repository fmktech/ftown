# Bridge package — agent notes

## Harness (local session control)

The package entrypoint's `ftown setup` explicitly installs or upgrades integrations
before bridge startup. For upgrades use `npx ftown@<new-version> setup`; the
installed copied alias does not discover newer packages. Installed
`ftown setup --repair` repairs its current version.

Setup provides:

- `~/.ftown/bin/ftown-harness` — stable CLI entry (wrapper → package `harness-cli.js`)
- `~/.ftown/bridge.json` — port, token, `harness` path
- `~/.ftown/harness-agent.md` — short pointer to the authoritative ftown skill (generated during setup)

Implement command behavior in `src/harness-commands.ts`, `src/sessions-commands.ts`,
and `src/env-commands.ts`. Entry files are thin aliases to `src/ftown-cli.ts`.
`src/setup.ts` owns installation; `src/setup-state.ts` gates ordinary startup
before auth/listeners or data migration. Cleanup migration IDs live in
`src/setup-migrations.ts`; use `ftown setup --repair` to repeat safe checks.

## Versioning

Any PR that changes `bridge/**` must bump `bridge/package.json` and keep
`bridge/package-lock.json` in sync. CI enforces this because `main` publishes
the bridge package to npm.

Use:

```bash
npm version patch --no-git-tag-version
```

See [npm releases](../docs/npm-release.md) for dual publication and the separate
first-publication/trusted-publisher prerequisites for each package.

### Dev

```bash
npx ftown setup
npm run harness -- status
npm run build   # builds canonical ftown command and compatible launchers
```

### Tests before PR

```bash
npm run build
ftown harness status       # requires a task-owned running bridge
```
