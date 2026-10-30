# Implementation handoff

Assisted updates now default to enabled for the existing eligible launch modes; `--no-allow-updates` opts out, and the last explicit switch wins. No update is installed without an explicit request. Metadata discovery validates the fixed origin, stable version, integrity, commit and bounded engine text independently of runtime. The coordinator reports the known version and Node requirements, blocks incompatible requests before receipt or stage, and preparation still strictly checks Node compatibility before filesystem mutation. Unknown or unrecognized engine grammar never installs.

Changed files: `bridge/src/index.ts`, `update-options.ts`, `update-options.test.ts`, `update-release.ts`, `update-release.test.ts`, `bridge-update.ts`, `bridge-update.test.ts`, `update-protocol.ts`; `bridge/package.json` and `package-lock.json` version only 0.19.61 to 0.19.62; `ui/src/hooks/useBridgeUpdates.ts` and its test; `ui/src/components/BridgeUpdatesDialog.tsx` and its test; `e2e/tests/bridge-updates.spec.ts`; `README.md`; `docs/investigations/2026-10-30-update-unknown-node.md`; and this handoff.

Red-before-green: incompatible discovery failed with `Unsupported release metadata`, and status lacked `currentNodeVersion`; parser test initially failed because the extracted option module did not yet exist. The unchanged installed path had no default opt-in. Green checks:

- Node 24.12.0: `env -u FTOWN_DATA_DIR node --import tsx --test src/update-release.test.ts src/bridge-update.test.ts src/update-options.test.ts` from bridge, 19 passed including the offline npm config test.
- Node 24.22.1: same files with `--test-skip-pattern='uses separate private npm configs'`, 18 passed; the isolated npx-provided Node has no sibling `npm`, which the skipped existing test requires. The test passed under Node 24.12.0 above.
- Node 24.22.1: bridge `npm run build` passed; UI `npx vitest run src/hooks/useBridgeUpdates.test.ts src/components/BridgeUpdatesDialog.test.tsx` passed 10 tests; UI `npx tsc --noEmit` passed; `git diff --check` passed.

Root owns the listener tests, actual bridge startup and focused `npx playwright test tests/bridge-updates.spec.ts --project chromium` from e2e with the isolated service fixture, and the full integration/CI gates. The E2E asserts that the development launch remains unsupported and the update button is disabled at desktop and mobile sizes. No real user bridge update/restart, E2E, server, network test, install or Git operation was performed by this worker. Node modules are prepared symlinks and are not commit contents.

All implementation, version/lock and documentation leases released to root and the independent reviewer; root will route any concrete review fixes back under a new lease.
