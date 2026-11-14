# Chaos box factsheet (verified)

Every command below was run inside `ftown-chaos-box:dev` with `docker run --network none`
(see `box/smoke.sh`, `box/in-box-smoke.sh`). Line numbers are against the bridge source at
the commit this file was added on.

## Image

- Base: `node:24.22.1-bookworm-slim@sha256:be8204d4…cd605c` (matches `.nvmrc` 24.22.1;
  satisfies `bridge/package.json` engines `^24.22.1`). linux/amd64 only.
- Bridge built from source at `/opt/ftown/bridge` (`npm ci && npm run build && npm prune --omit=dev`;
  node-pty compiled in a builder stage with python3/make/g++ and load-tested at build time).
- `/opt/chaos` = `chaos/box/`, `chaos/src/` (non-test), `chaos/package.json`, and
  `source-fingerprint.json` (no node_modules). `/opt/chaos-bin/ftown` = wrapper for
  `node /opt/ftown/bridge/dist/ftown-cli.js` (first on PATH).
- Centrifugo `v6.10.2` linux-amd64 archive downloaded at build time and verified against
  `CENTRIFUGO_SHA256['linux-amd64']` (`bridge/src/solo/contract.ts:79-91`); the build fails on
  mismatch (`sha256sum -c`). Seed: `/opt/chaos-seed/hub/centrifugo-v6.10.2` + `.sha256` sidecar
  holding the ARCHIVE digest — that is what the cache check compares
  (`bridge/src/solo/hub-manager.ts:200-218`). `up.sh` copies both to `/data/solo/bin/`.
- Panel stub `/opt/chaos-seed/panel/server.js`: the panel manager spawns `node server.js` with
  `HOSTNAME=127.0.0.1 PORT=<port>` and probes `HEAD /` (status < 500 = up, 45 s max)
  (`bridge/src/solo/panel-manager.ts:76-78,546-561,600-616`). `FTOWN_SOLO_PANEL_DIR` skips the
  bundle download (`bridge/src/index.ts:385-390`).
- User `ftown` uid/gid 1000, home `/home/ftown`, shell `/bin/zsh` (renamed `node` user).
- Size: ≈180.9 MB (180,866,438 bytes). Clean `--no-cache` build: 84 s on the dev Mac (amd64 emulation, base layers pulled); cached ≈ 5 s.

## Setup

- `ftown start` refuses to run unless `ftown setup` completed for this exact version
  (`bridge/src/start-commands.ts:16`, `bridge/src/setup-state.ts:37-68`). State lives in
  `$HOME/.ftown` (NOT the data dir), so it is done at BUILD time as user ftown.
- Setup is local file writes (hooks, skill, CLI copy). It probes for `codex`/`opencode`/`muse`
  binaries and skips each when absent (`bridge/src/setup.ts:36-62`); no agent CLI is required and
  no network is used.

## Environment (as `box/env.sh` `as_ftown` sets it)

`HOME=/home/ftown FTOWN_DATA_DIR=/data TMUX_TMPDIR=/run/chaos/tmux FTOWN_SOLO_PANEL_DIR=/opt/chaos-seed/panel
PATH=/opt/chaos-bin:/home/ftown/.ftown/bin:/usr/local/bin:/usr/bin:/bin`, run via
`setpriv --reuid=1000 --regid=1000 --init-groups env -i …`.

- `FTOWN_DATA_DIR=/data` is REQUIRED for every CLI call: with a non-default `--data-dir` the
  bridge pointer is `/data/bridge.json`, not `~/.ftown/bridge.json`
  (`bridge/src/ftown-home.ts:40-44`, `bridge/src/index.ts:207-215,943`,
  `bridge/src/cli-client.ts:12-13`).
- Sessions inherit `FTOWN_SESSION_ID` and `FTOWN_PARENT_SESSION_ID` from the bridge
  (`bridge/src/claude-runner.ts:246,254`). Commands run OUTSIDE a session (the supervisor) must set
  them explicitly to act as that session.
- tmux socket name is `ftown` (`bridge/src/tmux.ts:10`): `tmux -L ftown ls` as user ftown with the
  same `TMUX_TMPDIR`. Each session is `ftown-<id>`, wrapped as `/bin/zsh -l -c '<command>'`
  (`bridge/src/tmux.ts:138-147`). Box tmux is 3.3a (≥ 3.02 required, `tmux.ts:15`).

## Start / stop

- `up.sh` (root): `node /opt/ftown/bridge/dist/ftown-cli.js start --solo --data-dir /data --port 8040`
  as ftown; pid (the node process itself, checked via `/proc/<pid>/cmdline`) in
  `/run/chaos/bridge.pid`; log `/run/chaos/out/side-bridge.log`; ready when `ftown sessions list`
  answers (bounded 60 s).
- Measured: first solo start ≈ 3.4 s to ready; restart after `kill -9` 1.6–3.6 s. Sessions survive
  the kill (tmux keeps them) and are listed `running` after restart.
- `down.sh`: SIGTERM, SIGKILL after 10 s.
- Liveness (`box/env.sh` `bridge_alive`): a pid counts as the bridge only if `/proc/<pid>/stat` state
  is not Z/X (kill -0 succeeds on zombies, and PID 1 in the box/VM may not reap) AND its cmdline
  contains `ftown-cli.js start`. `up.sh` checks this first, before any chown/chmod: live bridge →
  exit 0 no-op; stale/foreign pid file → removed, start proceeds. Readiness timeout kills the
  started bridge and removes the pid file. Smoke steps `up-noop-when-live`, `up-after-stale-pid`
  (kill -9 with the pid file left in place), `new-pid-after-stale`.

## CLI lines that worked (all as `as_ftown …`)

- Create root: `ftown sessions create --shell claude --command /run/chaos/scripts/sleeper.sh --name root --workdir /work/repo`
- Create child: same plus `--parent-id <rootId>` (`bridge/src/sessions-commands.ts:160-172`).
  Output (pretty-printed, multi-line JSON — parse the whole stdout, not one line): `{"session":{"id","name","command","status":"running","bridgeId","createdAt","updatedAt","workingDir","shellType","parentSessionId"?,"runtime":"tmux"}}`.
- `--command` with `--shell claude` is used VERBATIM; `--plugin-dir` is added only when the
  command equals the generated `claude --allow-dangerously-skip-permissions[ --resume <id>]`
  (`bridge/src/agent-commands.ts:40-58`). Verified: list shows `"command":"/run/chaos/scripts/sleeper.sh"`.
- Mail to id: `ftown harness mail send <id> --type task "CHAOS-M-1 from=external to=child1"` (no
  session env needed). Lands in `/data/sessions/<id>/inbox.jsonl` (`bridge/src/mail-store.ts:88`) as
  `{"id":"mwg1ek5s-eec7d8","ts":"…Z","from":"external","to":"<id>","type":"task","body":"CHAOS-M-1 from=external to=child1"}`.
- Mail to parent: `env FTOWN_SESSION_ID=<child> FTOWN_PARENT_SESSION_ID=<root> ftown harness mail send --parent --type result "…"`
  → stdout `mail <mailId> sent to <rootId>`. Without `FTOWN_PARENT_SESSION_ID`: exit 1
  `--parent requires FTOWN_PARENT_SESSION_ID to be set`.
- Mail read (agent form): `env FTOWN_SESSION_ID=<id> ftown harness --json mail read` (global
  `--json` BEFORE `mail`) prints pretty-printed JSON
  `{"sessionId":"<id>","messages":[{"id","ts","from","to","type","body","deliveredAt","deliveredVia":"drain"}]}`
  and marks the messages delivered. Smoke step `mail-read-json`. Without `--json` it prints
  `[<ts>] <fromName> (<type>): <body>` lines, then `(no mail)` once drained. Flags `--peek`, `--all`, `--limit <n>`.
- Ask: `env FTOWN_SESSION_ID=<child> FTOWN_PARENT_SESSION_ID=<root> ftown sessions attention --title CHAOS-Q-1 --message pick --option yes --option no --wait --timeout 30`
  → routed to the parent as an `escalation` mail whose body starts
  `[ftown question id=<eventId> from=<childName> (<childId>)] CHAOS-Q-1`; on answer prints
  `Q: pick` / `A: yes`, exit 0; timeout exit 124; dismissed exit 2
  (`bridge/src/sessions-commands.ts:201-212`).
- Routed list: `env FTOWN_SESSION_ID=<root> ftown attention list --json` →
  `{"items":[{"sessionId","sessionName","event":{"id","sequence","type":"agent_needs_input","title","message","prompt":{"channel":"mail","questions":[{"question","options":[{"label"}],"multiSelect","allowText"}]},"route":"parent","routedTo"}}]}`.
- Answer as parent: `env FTOWN_SESSION_ID=<root> ftown attention answer <childId> <eventId> --option yes`
  (`--option` is a 1-based index or exact label; `--text`, `--answers-json`) → exit 0. Without
  `FTOWN_SESSION_ID`: exit 2; with a wrong event id: exit 4 `permission_denied`.
- List: `ftown sessions list` → `{"sessions":[<session as above>]}`. Get: `ftown sessions get <id>`
  → `{"session":{…},"capabilities":{…}}`.
- Stop/remove: `ftown sessions remove <id>` → `{"removed":true,"sessionId":"<id>"}`. There is no
  separate `stop` subcommand.

## Network in solo mode (all verified to not block start with `--network none`)

| Attempt | Where | In the box |
|---|---|---|
| Centrifugo download | `solo/hub-manager.ts:220-224` | skipped: seeded cache + sidecar hit (`:213-218`) |
| Panel bundle download | `index.ts:391-394` | skipped: `FTOWN_SOLO_PANEL_DIR` (`index.ts:385-390`) |
| npm update check / prepare | `update-release.ts:8,68` via `index.ts:920-931` | never: `support()` returns `not_enabled`/`unsupported_launch` for `--solo` (`index.ts:924-925`) |
| Push notifications | `push-notifier.ts:83` | never: created only with an account relay (`index.ts:759`) |
| Claude quota (`api.anthropic.com`) | `quota/claude.ts:14,269` | on demand only; returns early without `~/.claude/.credentials.json` (`:182-184,254-255`) |
| STUN `stun.l.google.com` | `direct-transport/contract.ts:9`, `peer-manager.ts:371` | only when a browser opens a WebRTC pair; none in the box |
| Hub / panel / local API / loopback WS | 127.0.0.1 ephemeral ports | loopback only (works with `--network none`) |

The bridge log under `--network none` shows no network error; startup reaches
`[Bridge] Ready and listening for commands`. Solo front listens on `:::8040`.

## Hook script and /run/chaos layout (contract v3)

- `CHAOS_HOOK_SCRIPT=/opt/ftown/bridge/hooks/notify.sh` — the bridge's own script from this
  build, unmodified (build asserts it is byte-identical to the copy setup installs at
  `/home/ftown/.ftown/notify.sh`, `bridge/src/install-notify-script.ts:5,17`). Exported in the image
  ENV and by `as_ftown`. It needs bash, jq, curl (`bridge/hooks/notify.sh:8-65`), all installed.
  It finds the bridge via `FTOWN_BRIDGE_POINTER` (`notify.sh:17`), which the bridge sets for its
  children (`bridge/src/index.ts:215`); outside a session set `FTOWN_BRIDGE_POINTER=/data/bridge.json`.
- `/run/chaos` is root:root 0755 (so `t0` and `ids.json` written by the root supervisor are
  readable by ftown); `agents/`, `scripts/`, `tmux/` are owned by ftown. Smoke step
  `run-chaos-layout` checks both.

- Hook acceptance: smoke step `hook-script-run` pipes `{"hook_event_name":"Stop","session_id":"<id>"}`
  into `$CHAOS_HOOK_SCRIPT` with `FTOWN_SESSION_ID`, `FTOWN_HOOK_PORT`, `FTOWN_HOOK_TOKEN` (the vars
  the bridge injects into sessions, `bridge/src/claude-runner.ts:245,250`; values = `.port`/`.token`
  of `/data/bridge.json`); exit 0. `hook-accepted-200` repeats the same POST to
  `http://localhost:<port>/hook` with curl and gets HTTP 200.
- Installed hook paths: `/opt/ftown/bridge/hooks/notify.sh` (what the fake agent defaults to; exists)
  and setup's identical copy `/home/ftown/.ftown/notify.sh`.
