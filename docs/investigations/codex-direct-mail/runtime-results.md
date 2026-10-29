# Root runtime evidence — 2026-10-29

Executed by root after W1 released writes:
`cd /tmp/ftown-codex-direct-mail/bridge && rtk proxy node --import tsx ../docs/investigations/codex-direct-mail/runtime-smoke.ts`

Exit 0. Passed:
- Task-owned encrypted LocalApiServer on ephemeral loopback port 61065; built harness CLI status reported up using isolated FTOWN_DATA_DIR.
- Public encrypted inbox POST → durable MailStore → production native process adapter → fake Codex executable argv → matching admission receipt → history marked deliveredVia cli and pending inbox empty.
- Full multiline Unicode body exceeding 4096 characters and containing shell metacharacters preserved literally.
- Failed enqueue left durable mail pending; no terminal writes in either scenario.

This is a real HTTP/filesystem/subprocess integration check with a simulated Codex receiver, not an inference run against a real Codex session. Installed real Codex 0.165.0 supports queue flags (help inspected). No user sessions or global pointer/configuration touched. Runtime harness exited and removed its temporary data and server; cleanup verified separately. Source diff whitespace check passed.

Root also ran `cd bridge && rtk proxy node --import tsx --test src/local-api-server.test.ts src/mail-store.test.ts`: exit 0, 21 tests passed, no failures. This covered adjacent recovery wiring and encrypted HTTP paths, including native heartbeat compatibility. No production/shared database used; tests owned their temporary loopback listeners. Smoke port closed and no `ftown-codex-mail-smoke-*` temporary directories remained after completion.
