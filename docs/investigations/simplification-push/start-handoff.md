# Canonical startup handoff

Owner: `/root/canonical_start`, explicit `gpt-6.1-sol` / `high`. Shared checkout `/Users/fkesheh/projects/ftown-simplify-all`. No Git, dependency, generated-output or E2E resource leases acquired.

## Changes

- `bridge/src/ftown-cli.ts`: discovers and dispatches `ftown start`.
- `bridge/src/start-commands.ts`: checks setup readiness before dynamically importing bridge/native dependencies. Standalone `--help` / `-h` stays available before setup. Arguments and exit code pass through unchanged.
- `bridge/src/index.ts`: exports `runBridge(argv, commandName = 'ftown-bridge')`, creates fresh Commander state, maps Commander help/parser exit codes, and guards the compatible direct entrypoint. Import does not parse or start. Existing action readiness remains before identity, migration, authentication and listeners.
- The same index owns hosted-only `BridgePushNotifier` wiring. Current bridge JWT starts from onboarding response and updates through the existing refresh path. AttentionStore's third callback forwards committed notices. Shutdown stops notification work. Local/Solo modes create no notifier.
- Canonical command and startup tests cover missing setup without HOME writes, readiness-before-loader ordering, argument/exit-code forwarding, and help/option-value distinctions.
- README, Solo guide and installed skill show `npx ftown start` / `ftown start` while documenting compatibility and explicit setup/upgrades.
- `cli-smoke.mjs` is authored for root execution only. It reuses `copyProductionDependencies` to construct a real npm-shaped package fixture and deletes that fixture cache before testing installed startup.

## Checks performed

- `rtk proxy node --import tsx --test src/ftown-cli.test.ts src/start-commands.test.ts` in `bridge`: **8 passed, 0 failed**.
- `rtk proxy node_modules/.bin/tsc --noEmit --pretty false` in `bridge`: **passed**, including notifier/store integration types after peer files appeared.
- `rtk proxy node --check docs/investigations/simplification-push/cli-smoke.mjs`: **passed**.
- No E2E, live bridge, browser, server, database or CI execution performed by this worker.

## Root runtime gate

After the integration owner builds the combined bridge and all writers stop:

```bash
rtk node docs/investigations/simplification-push/cli-smoke.mjs
```

The smoke creates its own temporary HOME/USERPROFILE, cwd, production package dependency closure and restricted PATH. It exercises npm bin-shaped `start --local`, installed `start --local` after original fixture cache deletion, setup fresh/current/repair, missing runtime rejection, downgrade protection, read-only start/create help, a real shell session, compatibility launcher help, shutdown pointer cleanup, and `--solo --rotate-key --port --data-dir` forwarding without listeners. Cleanup only addresses its recorded child process group, sessions and scratch directory.

Full Solo hub/panel startup is not exercised by this smoke: the forthcoming package version may have no released panel artifact yet. The offline rotation path verifies canonical Solo dispatch without downloads. Root may additionally run real Solo against a matching released artifact or supplied bundle and record that separately.

No application-scope findings remain. Source writes and all leases are released pending independent review or a concrete repair assignment. The package version/lock bump, installer copy inventory and release work remain with `/root/npx_implementation`.
