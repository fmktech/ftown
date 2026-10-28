# Bridge update validation — 2026-10-28

Built fresh in `feat/bridge-update-flow` from main `ce62d9d3c118528df70b9e49aceea4aaf1e28819`. Deleted the obsolete local `feat/version-update` (old tip `72d4c04a35855e345f312b8cabb5e971add0c58e`); no live remote branch existed. Unrelated dirty checkouts and all three pre-existing stashes were preserved.

## Final results

| Gate | Result |
| --- | --- |
| Bridge `npm run build` | Passed |
| Bridge `npm test` | 1,084 passed, 4 existing skips, 0 failed (1,088 tests) |
| UI `npm test` | 747 passed across 73 files |
| UI `npm run build` | Passed |
| Bridge/UI/E2E TypeScript checks | Passed |
| `node --test scripts/release/*.test.mjs` | 17 passed, including real dual-package artifact parity |
| `playwright test tests/bridge-updates.spec.ts` | 3 passed: desktop1280, mobile390, explicit app update notice |
| Existing `tests/session-lifecycle.spec.ts` | 4 passed, 1 existing platform skip in preceding combined run |
| `cd bridge && node scripts/bridge-update-smoke.mjs` | Four real process cases passed: cancel, success, setup failure, ready failure |
| `cd bridge && node scripts/bridge-update-real-smoke.mjs` | Real local fixture0.19.58 →0.19.59 passed; identity/port retained; authenticated replacement harness callable |
| Installed fixture `ftown harness status` | Passed after final build |
| Independent source/security/lifecycle review | All findings closed; final manual-command and readiness fixture repairs accepted |
| Desktop/mobile rendered review | Dialog readable, controls fit, touch targets≥44px; Escape returns focus; no horizontal overflow; unchanged production app build shows no update notice |
| `git diff --check` | Passed |

All runtime/browser execution was root-owned in Boat sandbox `bx_tcb4qcnu` with Node24.22.1, npm11.19.1, isolated scratch homes and local Docker PostgreSQL. Database, deployment, Docker, ports and HOME selectors were verified before mutation. No production bridge, production database or published npm package was modified. The real update smoke stages a controlled local package fixture; it is not evidence of a published upgrade. A full E2E suite was not run; focused coverage satisfies the requested PR gate.

## Failures investigated and resolved

- Actual npm rejected a shared `/dev/null` user/global config path; distinct private empty npmrcs fixed it, with an actual offline npm probe and real staging coverage.
- Full UI tests exposed a callback-identity rerender loop; a stable controller forwarding the latest sender fixed it. Dashboard25 and the full747 tests passed without increasing heap.
- Existing startup AST tests omitted the new async readiness dependencies/completion. The harness now executes the real async startup path; original assertions remain, plus delayed/failed private ACK checks.
- Browser tests initially selected an unapproved bridge. Selecting the default paired bridge by its real ID fixed both viewports without relaxing security or assertions.
- Rendered output revealed manual downgrade guidance when installed>stable. Commands now choose stable only when newer, otherwise installed; four-way unit and browser assertions pass.
- A root validation wrapper's umask077 caused an unchanged production-dependency fixture to create mode0700 rather than its expected0755. Isolated077 failure and022 success confirmed the environment difference. Restoring the normal022 mask for the unit command yielded the complete passing suite; application/tests were not weakened for it.
- One intermediate wrapper reached all3 passing E2E tests and installed harness status but hit Boat's default30s during cleanup. Root explicitly removed the remaining owned containers, then used a bounded300s command for the final run; final wrapper exited0 with cleanup complete.

Private logs, failure evidence and screenshots are preserved under the repository common Git directory's `agent-receipts` (outside committed source). Validation scripts use the repository's existing service/setup/test commands. Task-owned services, local test containers and browser trust were removed after final checks; root deleted sandbox `bx_tcb4qcnu` after retrieving the final evidence archive and screenshots, and verified it absent from `boat list` at14:01UTC.

Assisted updates intentionally require an explicitly opted-in installed POSIX bridge, default data/home, an unsupervised single-bridge installation, and stopped sessions. Unsupported launch modes retain manual instructions. The helper preserves uncertain ownership/outcomes; automatic rollback is not promised.
