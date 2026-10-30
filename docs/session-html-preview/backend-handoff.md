# Bridge preview handoff

The CLI registers a single self-contained HTML file using the encrypted local API. Its public session descriptor contains only the preview identity and filename; the source path stays in private storage and is removed from session and archive egress. Browser readers use the existing authorized command channel to obtain bounded status and chunks, with a revision check before content is returned. File reads are confined to the session working directory, reject symlinks, invalid UTF-8 and files over 1 MiB, and allow at most four concurrent reads.

Session metadata mutations, retry, removal and resurrection use the session queue and reload fresh state. A read in progress is fenced against registration, clear or removal before its result is returned. `usage.md` and the shipped ftown skill document registration, clearing and atomic updates.

Changed bridge files:

- `package.json`, `package-lock.json` (patch version 0.19.60 to 0.19.61 only; no install).
- `src/session-preview.ts`, `src/session-preview.test.ts`, `src/types.ts`, `src/session-wire.ts`, `src/session-controller.ts`, `src/session-resurrection.ts`, `src/session-store-retirement.test.ts`.
- `src/local-api-server.ts`, `src/command-rpc.ts`, `src/index.ts`, `src/security/bridge/permissions.ts`, `src/security/bridge/permissions.test.ts`, `src/security/bridge/security.test.ts`.
- `src/sessions-commands.ts`, `src/sessions-commands.test.ts`, `skills/ftown/SKILL.md`, `skills/ftown/references/sessions.md`.
- `docs/session-html-preview/usage.md` and this handoff. Frozen `src/preview-protocol.ts` was not edited.

Checks on Node 24.22.1 using the prepared read-only dependencies:

- `npm run build`: passed.
- Focused six-file unit run: 65 passed; subsequent expanded `node --import tsx --test src/session-preview.test.ts`: 11 passed, including forced read/clear/remove/replace, usage, retry and resurrection interleavings, concurrency cap and growth after stat.
- `node --import tsx --test --test-name-pattern='browser control cannot register preview|encrypted archive response omits preview' src/security/bridge/security.test.ts`: 2 passed without starting a listener.
- Tests were run with `FTOWN_DATA_DIR` unset because the inherited setting points at the user's real data; initial tests with the inherited environment were invalid and were rerun isolated.

Root owns full bridge `env -u FTOWN_DATA_DIR npm test`, combined build, real CLI/browser E2E, service setup and cleanup. In particular, actual restart/revive and end-to-end encrypted transport remain runtime acceptance checks. No servers, E2E, CI, installs or Git history operations were run by B1. Independent review and any findings remain root-coordinated.

B1 stops writing and releases bridge source, test, version/lock and documentation leases for review and integration. Prepared `node_modules` symlinks are not task changes to commit.

B2 updates the two exact capability assertions in `bridge/src/local-api-server.test.ts` to include the intentional `sessionMetadata.preview: true` flag, preserving the attention-present and attention-unavailable checks. Root owns the listener test and full-suite rerun. B2 releases both assigned file leases.
