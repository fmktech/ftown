# Platform support analysis: Linux, WSL2 and native Windows

Status: analysis only, no code changed. Audited at `ac8c8b5` (main, 2026-11-15).

ftown is developed and run on macOS. This document records what works elsewhere today,
what is broken, and a roadmap of small tasks to close the gaps.

## How to read this

- Every finding cites `path:line`. The lines for the load-bearing findings were re-read
  against the tree after the audit; the rest come from a read-only sweep and should be
  re-checked when a task picks them up.
- **Nothing here was executed on Linux, WSL2 or Windows.** All verdicts are from reading
  code. "Works" means no obstacle was found in the source.
- Verdicts: **works** / **caveat** (works with a precondition or a degraded feature) /
  **broken** / **unknown** (depends on upstream CLI behaviour not derivable from this repo;
  a verification step is given).
- Security-sensitive observations made during the audit are not in this file (public
  repository). They are in the git-ignored `.security-notes/platform-audit.md`.

## Summary

| Area | Linux | WSL2 | Native Windows |
|---|---|---|---|
| Session runtime | caveat: needs `/bin/zsh`; tmux optional | caveat: same as Linux | broken in practice: PowerShell direct mode exists but is untested and receives POSIX command strings |
| `ftown setup`, launchers, PATH | works (zsh/bash only) | works | broken: bash launchers, symlinked skills, no PATH handling |
| Hooks (all harnesses) | caveat: need `bash`, `jq`, `curl`; silent no-op if missing | caveat: same | broken: `.sh` hooks executed directly |
| Harness adapters | works/caveat per harness | same | broken or unknown per harness |
| Quota readers | caveat (grok refresh off, claude creds file unverified) | caveat | caveat/broken (`.cmd` shims, no `.exe` names) |
| Worktrees / git | works | works | caveat (reserved names, MAX_PATH, drive-letter case) |
| Solo (native) | works (amd64, arm64) | works in principle; LAN banner misleading | broken: platform rejected |
| Solo (Docker) | caveat (uid 1000 bind mounts) | works | caveat (`${HOME}` mounts empty in PowerShell) |
| Self-update | works | works | disabled by design |
| UI | caveat (Cmd-only shortcut) | caveat | caveat + POSIX host snippets broken |
| CI coverage | ubuntu only, launch proof skipped in unit job | none | none |

The short version:

1. **Linux and WSL2 are close.** The one hard blocker is the hardcoded `/bin/zsh`. The rest
   is undeclared prerequisites (`jq`, `curl`, `tmux`) that fail silently, and a few
   macOS-only quota features.
2. **Native Windows is a separate port, not a bug list.** A PowerShell direct runtime
   exists, but setup, launchers, hooks, binary probes and Solo all assume POSIX. The hook
   layer is the largest piece: every hook is a bash script.
3. **CI proves none of it.** Every job runs on `ubuntu-latest`, the unit job has no zsh, and
   the only Windows tests in the repo never execute anywhere.

Recommendation: finish Linux/WSL2 first (phases 0 and 1, roughly a week of small tasks),
state WSL2 as the supported way to run on Windows, and treat native Windows (phase 3) as a
decision to make after that, because it requires rewriting the hook layer in Node.

## Findings by area

### 1. Session runtime

Runtime selection is the only platform branch in the launch path:

- `bridge/src/claude-runner.ts:84` returns `'direct'` on win32; `:85` uses tmux when
  available and falls back to direct (node-pty) otherwise.
- `bridge/src/tmux.ts:22` probes `tmux -V`; absence is handled (no install hint is printed).
  tmux uses a named socket (`tmux.ts:10`, `-L ftown`) and `~/.ftown/tmux.conf`
  (`tmux.ts:60-61`).

Shell:

- `bridge/src/tmux.ts:147` wraps every tmux session in `/bin/zsh -l -c`.
- `bridge/src/direct-shell.ts:17` uses `/bin/zsh -l -c` for every non-Windows direct
  session. There is no `$SHELL` or bash fallback.
- `bridge/src/harness-registry.ts:374` hardcodes `/bin/zsh -l` for the plain shell harness.
- `bridge/src/harness-registry.ts:227-229` notes that `zsh -l -c` does not source `.zshrc`,
  so a CLI whose PATH entry lives only in `.zshrc` is not found.
- `bridge/src/direct-shell.ts:9-15` is the Windows branch: Windows PowerShell 5.1 with
  `-NoProfile -Command`.

Command strings handed to PowerShell are authored for POSIX:

- `bridge/src/harness-registry.ts:14` has win32 quoting (single quotes, doubled).
- `bridge/src/harness-registry.ts:206` (`"$HOME/.ftown/pi/ftown.js"`) and `:231`
  (`"$HOME/.kimi-code/bin/kimi"` as the command word) rely on POSIX expansion. A quoted
  string in command position is not an invocation in PowerShell without `&`.

Signals and temp files:

- `bridge/src/claude-runner.ts:189`, `:196` call `proc.kill()` then `proc.kill('SIGKILL')`
  on the pty. node-pty's Windows `kill` behaviour with a signal argument is unverified.
- `bridge/src/index.ts:1139-1140` handle SIGINT and SIGTERM; SIGTERM is not delivered on
  Windows.
- `bridge/src/update-handoff.ts:308-311`, `bridge/src/update-release.ts:112-114` and
  `bridge/src/quota/grok.ts:390` use negative-pid process-group kills (POSIX only).
- `bridge/src/harness-commands.ts:443` hardcodes `/tmp/ftown-mail-pump-<id>.count`, with
  write errors swallowed (`:457-459`). `bridge/src/tmux.ts:44`, `:109` correctly use
  `tmpdir()`.

| | Linux | WSL2 | Windows |
|---|---|---|---|
| tmux runtime | works if tmux ≥ 3.2 and zsh installed | same | not used |
| direct runtime | **broken without `/bin/zsh`** | same | unknown: never run in CI |
| mail-pump counter | works | works | broken silently (`/tmp`) |

Verify: on a stock Ubuntu or Debian image (no zsh) run `ftown start` and create a session;
expect the pane to exit immediately. On Windows, install bridge deps and run
`bridge/src/direct-shell.test.ts`, then launch each harness once.

### 2. CLI, setup and the `~/.ftown` layout

- `bridge/package.json:7-14` bin map; no `os`/`cpu` fields; native deps `node-datachannel`
  and `node-pty` (`:58-59`). No lifecycle scripts besides `prepublishOnly`.
- `bridge/src/install-ftown-command-cli.ts:46` writes each launcher (`~/.ftown/ftown`,
  `ftown-sessions`, `ftown-env`, `bin/ftown-harness`; list at
  `bridge/src/installation-manifest.ts:12-15`) as an extensionless
  `#!/usr/bin/env bash` script. There is no `.cmd` or `.ps1` shim.
- `bridge/src/ensure-ftown-path.ts:18` emits `export PATH="$HOME/.ftown:$PATH"`; `:83-84`
  always write `~/.zshenv`; `:86-87` write `~/.bashrc` only if it exists. Fish, a bash
  login shell reading only `.profile`, and PowerShell are not handled.
- `bridge/src/install-ftown-skill.ts:61`, `:78`, `:87` create skill links with
  `symlinkSync` and no fallback; the call is uncaught from `bridge/src/setup.ts:101`.
  `bridge/src/setup-state.ts:44` then checks readiness with `readlinkSync`, so a copied
  skill would report "not ready". On Windows without Developer Mode, `symlinkSync` throws
  `EPERM` and `ftown setup` aborts.
- `bridge/src/setup.ts:41-42` throw if the claude or cursor hook install fails.
- Prerequisites: `README.md:167-172` lists Node, Postgres, Centrifugo and agent CLIs. tmux,
  zsh, git, jq and curl are not mentioned and setup checks none of them. `README.md:557`
  defers Windows to "manual setup".
- No `.gitattributes` exists, so a Windows checkout with `core.autocrlf=true` rewrites the
  `.sh` hooks and `centrifugo/entrypoint.sh` to CRLF.
- No launchd/systemd service install and no browser-open call exist, so there is nothing
  to port there.

`~/.ftown` layout (all joined from `os.homedir()`, so the location itself is portable):

| Path | Defined at |
|---|---|
| `cli/` managed runtime | `install-ftown-command-cli.ts:16` |
| `ftown`, `ftown-sessions`, `ftown-env`, `bin/ftown-harness` | `installation-manifest.ts:12-15` |
| `bridge.json` | `cli-client.ts:12-13`, `ftown-home.ts:27` |
| `data/` and `data/solo/{bin,hub.pid,panel.pid,panel/<ver>}` | `ftown-home.ts:6`, `solo/hub-manager.ts:200-201`, `:343`, `solo/panel-manager.ts:594` |
| `setup-state.json`, `setup.lock` | `setup-state.ts:10`, `:96` |
| `skills/<name>` + links in `~/.agents/skills`, `~/.claude/skills`, opencode skills | `install-ftown-skill.ts:21`, `:37-39` |
| `env.json` | `env-commands.ts:125` |
| `tmux.conf` | `tmux.ts:61-63` |
| `model-routing.json` | `quota/types.ts:229`, `quota/routing-config.ts:386-387` |
| `quota-cache.json` | `quota/cache.ts:12` |
| `notify.sh`, `grok-hook.sh`, `antigravity-hook.sh` | `install-notify-script.ts:5`, `grok-hook-installer.ts:13`, `antigravity-hook-installer.ts:63` |
| `pi/ftown.js`, `muse-plugin.json` | `pi-extension-installer.ts:7`, `muse-plugin-installer.ts:189` |
| `update-reservation.json`, `updates/<op>/` | `update-handoff.ts:41`, `:96` |

| | Linux | WSL2 | Windows |
|---|---|---|---|
| `ftown setup` | works | works | broken (symlink, bash launchers) |
| `ftown` on PATH | works for zsh, and bash with `.bashrc` | same | broken |

### 3. Hooks (shared by every harness)

Every hook is a shell script that needs `jq` and `curl`:

- `bridge/hooks/notify.sh:1` is `#!/bin/bash` and uses `jq` (`:8`, `:21`, `:31`, `:55`).
- `bridge/hooks/ftown-grok-hook.sh:32-33` and `bridge/hooks/ftown-antigravity-hook.sh:37-38`
  exit 0 when `curl` or `jq` is missing. `bridge/muse-plugin/lib/ftown-hook.sh:35-36` does
  the same.
- Hook commands are written as bare script paths: `bridge/src/hook-installer.ts:170`
  (claude), `bridge/src/codex-installer.ts:157` (codex),
  `bridge/src/cursor-hook-installer.ts:94-97` (cursor),
  `bridge/src/grok-hook-installer.ts:27` (grok, executed without a shell).
  `bridge/src/hook-installer.ts:17` builds `<home>/.ftown/bin/ftown-harness hook-pump`
  unquoted, which breaks on a home directory containing a space.
- `bridge/src/antigravity-hook-installer.ts:76-77` writes a POSIX-quoted command ending in
  `2>/dev/null || true`.

Consequence on Linux/WSL2: a machine without `jq` gets sessions that launch but never
report status, attention or session ids, with no error anywhere. `jq` is not installed by
default on most distributions (nor on macOS). Consequence on Windows: no hook can run.

### 3.1 Shared Node hook entry point (P1.3 step 1)

`ftown-harness hook <kind>` is the typed shared entry point the four shell hooks will
be ported onto. Contract: `bridge/src/hook-contract.ts`; runner:
`bridge/src/hook-cli.ts`; transport: `bridge/src/hook-transport.ts`; adapters:
`bridge/src/hook-adapters.ts`. `kind` names a native input dialect, not a bridge event.

| kind | Native source | Reads | Posts |
|---|---|---|---|
| `notify` | Claude/Codex/Cursor | stdin object, `FTOWN_SESSION_ID`, `HOOK_EVENT_NAME`, `GROK_HOOK_EVENT`, session registry | stdin object plus `ftown_session_id`/`ftown_session_source`; a `{hook_event_name}` fallback when stdin is not an object |
| `grok` | grok harness | stdin, `GROK_SESSION_ID` | identity + `hook_event_name`, `session_id`, `cwd`, optional `tool_*`; Stop/end_turn drains the inbox first |
| `antigravity` | agy harness | stdin camelCase, `ANTIGRAVITY_CONVERSATION_ID` | snake_case identity + event, `session_id`, `cwd`, optional tool fields; Stop drains first |
| `muse-*` | muse plugin | stdin, per-event argv | SessionStart/UserPromptSubmit/Stop keep native `session_id` + `cwd`; tool events send only identity, tool name and call id |

Transport: loopback `POST http://127.0.0.1:<port>/hook` with
`Content-Type: application/json` and `Authorization: Bearer <token>` when present.
Candidates are `FTOWN_HOOK_PORT`/`FTOWN_HOOK_TOKEN` first, then the bridge pointer at
`FTOWN_BRIDGE_POINTER` or `~/.ftown/bridge.json` (`port`, `token`); exact duplicates are
dropped. First 2xx wins and each attempt is bounded at 2 s, so two candidates have a
4 s budget. No `jq` or `curl` is involved.

Errors: a missing, unknown or extra kind is a usage error (stderr, exit 2). A valid
event that cannot be parsed or delivered prints one sanitized stderr line and still
exits 0 — hooks must never block an agent, but failures are no longer silent. Stderr
never contains the token, pointer contents, payload or native input.

Registration: direct-exec harnesses use `buildHookExecArgv(executablePath, kind)` (or
`buildHookArgv(kind)` when the harness owns the executable); harnesses that store a shell
command use `buildHookShellCommand(...)`, which POSIX single-quotes every argument and
escapes embedded quotes so a path containing spaces survives.

Status: only `muse-session-start` has an adapter today; the other kinds fail visibly
until the four porting tasks land. This step removes no shell hook yet.

### 4. Harness adapters

Common: binaries are bare names resolved through the login shell PATH. Neither
`CLAUDE_CONFIG_DIR` nor `CODEX_HOME` is honoured (the only mention is
`bridge/src/native-mail.ts:69`). Probes that use `command -v` fail on Windows.

| Harness | Launch | Config/state paths | Linux / WSL2 | Windows |
|---|---|---|---|---|
| claude | `harness-registry.ts:308` | `~/.claude/settings.json` (`hook-installer.ts:129`), transcripts `~/.claude/projects` (`usage-collector.ts:330`), mod probe `claude-mod-installer.ts:43` | works with jq | caveat: `execFileSync('claude')` cannot spawn a `.cmd` shim so the mod is silently disabled; project-dir slug rule (`usage-collector.ts:115`) verified on macOS only; bash hook |
| codex | `harness-registry.ts:104-107` | `~/.codex/hooks.json` (`codex-installer.ts:100`), `config.toml` trust (`:206-233`), sessions (`usage-collector.ts:430`) | works | broken: `command -v codex` probe (`codex-installer.ts:48`) runs under cmd.exe, so setup skips codex |
| cursor | `harness-registry.ts:75` (binary `agent`) | `~/.cursor/hooks.json` (`cursor-hook-installer.ts:119`) | works; 300 ms spawn stagger (`harness-registry.ts:358`) is justified by a macOS keychain race, need unverified elsewhere | caveat: bash hook |
| grok | `harness-registry.ts:133` | `~/.grok` (`grok-hook-installer.ts:57`), script `~/.ftown/grok-hook.sh` | caveat: bash, jq, curl | broken: bash script executed directly |
| muse | `harness-registry.ts:253` | `~/.config/muse`, `~/.local/share/muse` hardcoded (`quota/models-muse.ts:15-16`, `usage-collector.ts:814`); XDG variables ignored | caveat: jq, curl; XDG override ignored | broken: `sh -c 'command -v muse'` (`muse-plugin-installer.ts:57`) |
| agy | `harness-registry.ts:285` | `~/.gemini/antigravity-cli/settings.json` (`antigravity-trust.ts:11`), `~/.gemini/config/hooks.json` (`antigravity-hook-installer.ts:248`) | caveat: sh, jq, curl | unknown/broken: `sh -c` hook command; config location unverified |
| opencode | `harness-registry.ts:177-178` | plugin at `~/.config/opencode/plugins/ftown.js` (`opencode-plugin-installer.ts:29`), ignoring `XDG_CONFIG_HOME`, although `install-ftown-skill.ts:32-33` honours it | caveat: plugin not loaded when `XDG_CONFIG_HOME` is set | broken: `command -v opencode` probe (`opencode-plugin-installer.ts:12`) |
| pi | `harness-registry.ts:204-206` | `~/.ftown/pi/ftown.js`, `~/.pi/agent/sessions` (`usage-collector.ts:232`) | works | caveat: `"$HOME/..."` argument under PowerShell |

Plugin runtimes written in Node are already portable: `bridge/opencode-plugin/ftown.js:27`
spawns `process.execPath`. That is the model for porting the shell hooks.

Unknowns to verify on a real machine per OS: where each CLI stores config on Windows
(run it once, list the home directory), whether Claude Code uses the same project-dir slug
rule on Windows (`dir %USERPROFILE%\.claude\projects`), and whether the cursor binary is
named `agent` everywhere.

### 5. Quota readers

No reader uses a shell; every CLI is spawned by bare name. On Windows, an npm-installed
CLI is a `.cmd` shim, which Node will not spawn without a shell.

| Provider | Source | Linux / WSL2 | Windows |
|---|---|---|---|
| claude | `<configDir>/.credentials.json` on every platform; macOS also tries the keychain first (`quota/claude.ts`, `resolveClaudeCredentialSources`); HTTP usage endpoint (`:14`) | works: Linux writes `~/.claude/.credentials.json` (mode 0600); `CLAUDE_CONFIG_DIR` moves it | works: `%USERPROFILE%\.claude\.credentials.json` |
| codex | `codex app-server` over stdio (`quota/codex.ts:290`); fallback `~/.codex/sessions` (`:402`) | works | caveat: `.cmd` spawn |
| grok | `~/.grok/logs/unified.jsonl`; refresh on darwin + linux via PATH-resolved `script`/`pgrep`/`ps`, with util-linux `script -qc` on linux and BSD `script -q /dev/null` on darwin (`quota/grok.ts`) | works on darwin + linux when grok is installed (live quota after a refresh) | caveat: log-only; `~/.grok/bin/grok` has no `.exe` candidate |
| muse | `muse usage --json` (`quota/muse.ts:195`) | works | unknown |
| agy | `~/.local/bin/agy` or PATH, no `.exe` (`quota/agy.ts:26-27`) | works | broken: binary never found |
| opencode | CLI API call (`quota/opencode.ts:19`); catalogue `~/.cache/opencode/models.json` (`quota/models-opencode.ts:34`) | works; `XDG_CACHE_HOME` ignored | caveat: no `.exe` candidate (`models-opencode.ts:28`, `:276`) |
| cursor | no reader | n/a | n/a |

`~/.ftown/model-routing.json` resolves from the home directory only and is portable
(`quota/routing-config.ts:386-387`).

WSL2 note: credentials are read from the Linux home. A CLI logged in on the Windows side is
invisible to a bridge running in WSL.

P1.8 verification (2026-11-16, Claude Code CLI 2.1.325): the
[authentication docs](https://code.claude.com/docs/en/authentication#credential-management)
confirm that Linux and Windows keep the login in `~/.claude/.credentials.json`
(mode 0600 on Linux) and that only macOS uses the Keychain, falling back to the
same file when the Keychain write is rejected. `CLAUDE_CONFIG_DIR` moves the
config directory, including the credentials file; the CLI also keys the macOS
Keychain entry to that directory by appending eight hex digits of its SHA-256
(observed in the 2.1.325 CLI binary). ftown's quota reader now resolves those
same sources, honours the override and lists every source it consulted in the
`auth` message. Fixture-home unit tests cover Linux and macOS.

### 6. Worktrees, git and paths

- Git is invoked with argv arrays and no shell (`bridge/src/worktrees.ts:50`), as is `gh`
  (`bridge/src/pull-request-status.ts:16`, `bridge/src/pull-request-review.ts:22`). This is
  portable.
- Worktrees live at `<repo>/.claude/worktrees/<slug>` (`worktrees.ts:138`). The slug
  sanitiser (`worktrees.ts:41`) lets Windows reserved device names through (`con`, `aux`,
  `nul`, `com1`…).
- `worktrees.ts:196` compares git's `--show-toplevel` with a `realpath` by string equality.
  Drive-letter case can differ on Windows, which would make status fail and block
  retirement.
- No `core.longpaths` or `core.autocrlf` handling exists. Deep trees under
  `.claude\worktrees\<slug>` can exceed 260 characters.
- `worktrees.ts:300-305` removes worktrees with no retry; Windows file locks from an open
  shell or editor will fail it.
- Path containment for previews uses `path.relative` and `sep`
  (`bridge/src/session-preview.ts:23`, `:40`) and is portable. `session-preview.ts:71`
  rejects a path unless `resolve(path) === path`, so `C:/x/y.html` is refused on Windows.
- `bridge/src/update-release.ts:171` and `bridge/src/update-handoff.ts:181` assume `/`,
  but updates are disabled on Windows (`bridge/src/index.ts:928`).
- There is no file watcher in the bridge, so inotify limits and `fs.watch` differences do
  not apply.
- The local API binds `127.0.0.1` over TCP (`bridge/src/local-api-server.ts:881`, `:898`);
  no unix sockets or named pipes are used.

| | Linux | WSL2 | Windows |
|---|---|---|---|
| Worktrees | works | works (keep repos on the Linux filesystem, not `/mnt/c`) | caveat: reserved names, long paths, case compare, locked removal |

### 7. Solo and Docker

- `bridge/src/solo/hub-manager.ts:99-102` accepts darwin and linux on x64/arm64 and throws
  `UnsupportedPlatformError` otherwise. Digests exist for those four triples only
  (`bridge/src/solo/contract.ts:87-90`). Native Windows Solo is rejected up front.
- Hub and panel extraction shell out to `tar` (`hub-manager.ts:240-246`,
  `solo/panel-manager.ts:227`, `:530`).
- The LAN banner lists interface addresses (`bridge/src/index.ts:103-114`). In WSL2 NAT
  mode and inside a container this is an address the LAN cannot reach; `docs/solo.md:207-210`
  documents the container case only.
- Docker image: `docker/solo/Dockerfile:44` (`node:22.23.4-bookworm-slim`), installs tmux,
  git, zsh, procps, tini (`:53-61`). `jq` and `curl` are not installed, so shell hooks are
  inert inside the image. Only two harness CLIs are installed (`:85`).
- `docker/solo/compose.yml:14` mounts `${HOME}/.pi/agent`. PowerShell and cmd do not set
  `HOME`, so the source resolves to `/.pi/agent`.
- `docker/solo/Dockerfile:69-70` runs as uid 1000; a Linux host user with another uid gets
  permission errors on the bind-mounted workspace (`compose.yml:13`).
- `docker/solo/compose.yml:4` tags the image `0.19.41` while `Dockerfile:85` pins bridge
  `0.19.50`.
- No multi-arch build (`buildx`, `platforms:`) exists in any workflow.
- Stale pid files after a container restart are a known issue (`docs/solo.md:177-186`,
  `solo/panel-manager.ts:782-812`).

| | Linux | WSL2 | Windows |
|---|---|---|---|
| Solo native | works | works; banner URL misleading | broken |
| Solo Docker | caveat: uid, no jq/curl in image | works | caveat: `${HOME}` mounts |

Docker Desktop is the only way to run ftown on a Windows host today without WSL.

### 8. UI

- `ui/src/components/NewSessionModal.tsx:555` submits on `metaKey` only and `:1010` shows
  "Cmd+Enter to submit". Ctrl+Enter does nothing on Linux and Windows. Other shortcuts
  already accept both (`ui/src/components/SessionOverview.tsx:486`, `:540`).
- The UI sends POSIX shell and `python3` snippets to the bridge host:
  `ui/src/components/Dashboard.tsx:341-346`, `ui/src/components/ClaudeSessionPicker.tsx:50-52`
  (also re-implements the project-dir slug with `tr`/`sed` for POSIX paths),
  `ui/src/components/CursorSessionPicker.tsx:50`. Linux needs `python3`; a Windows host
  cannot run them.
- Path display handles both separators (`ui/src/components/SessionList.tsx:114`, `:119`).
  Terminal fonts have generic fallbacks (`ui/src/components/Terminal.tsx:250`). No
  user-agent sniffing exists.
- `navigator.clipboard` is unavailable over plain-HTTP LAN Solo
  (`ui/src/components/Dashboard.tsx:98`, fallback at `:104`). Not OS-specific.
- Build scripts are plain `next`/`vitest` (`ui/package.json:13-17`) and portable.

### 9. Tests and CI

- Every workflow uses `runs-on: ubuntu-latest` with no OS matrix (for example
  `.github/workflows/unit.yml:14`, `.github/workflows/e2e.yml:14`).
- All jobs go through `scripts/ci/run-job.sh`, which is bash-only. The `unit` branch
  (`:37-43`) installs no packages. The `e2e` branch installs `zsh tmux libnss3-tools`
  (`:96`).
- `bridge/src/opencode-launch.test.ts:82-87` skips the launch proof when tmux or
  `/bin/zsh` is missing; the comment at `:90-93` records that unit CI has tmux and no zsh.
  The in-process launch proof therefore never runs in the unit job. Only
  `e2e/tests/opencode-launch.spec.ts` covers a real launch.
- `bridge/src/direct-shell.test.ts:37`, `:43`, `:48` are the only Windows runtime tests and
  are skipped off win32, so they run nowhere.
- `bridge/src/agent-commands.test.ts:19` and `bridge/src/harness-registry.test.ts:41`
  return early on win32 (reported as pass, not skip).
- 49 of 173 bridge test files depend on `#!/bin/sh` fixtures, `chmod`, symlinks, `/tmp` or
  signals (for example `bridge/src/antigravity-hook-installer.test.ts:28`,
  `bridge/src/session-store-retirement.test.ts:25`). A Windows runner would fail widely
  until these are tagged or ported.
- e2e assumes zsh (`e2e/tests/account-isolation.spec.ts:561`,
  `e2e/tests/idor-channels.spec.ts:106`) and a Linux-only browser-trust step
  (`e2e/scripts/setup-browser-trust.mjs:47`).
- Release artifacts are built once on ubuntu (`.github/workflows/publish-bridge.yml:77`,
  `.github/workflows/release-ui.yml:39`). `node-pty` and `node-datachannel` are never
  installed or loaded on Windows or macOS in CI. Whether prebuilt binaries exist for
  win32 on the pinned versions is unverified (run `npm ci` in `bridge/` on a Windows
  runner).
- `chaos/` has no workflow.

## Roadmap

Sizes: **S** ≤ half a day, **M** 1–2 days, **L** 3–5 days. Tasks inside a phase are
independent unless a dependency is named. Gates name the job that must be green; a new
job must be stable under repeated runs before it becomes required (flakes are failures).

### Phase 0 — make CI able to see the problem

| ID | Task | Size | Gate |
|---|---|---|---|
| P0.1 | Install `zsh tmux jq` in the `unit` branch of `scripts/ci/run-job.sh` so `opencode-launch.test.ts` stops skipping. | S | unit job log shows the launch proof ran (0 skipped in that file) |
| P0.2 | Add a `unit-minimal` job: ubuntu with no zsh, tmux or jq. This is the regression gate for phase 1. Allowed to fail until P1.1/P1.3 land, then required. | S | `ubuntu-latest` job, bridge `npm test` |
| P0.3 | Add a `windows-latest` **smoke** job, non-blocking: `npm ci` + `npm run build` in `bridge/`, load `node-pty` and `node-datachannel`, run `direct-shell.test.ts` only. Steps use `node`, not `run-job.sh`. | M | job exists and reports; answers the prebuild unknown |
| P0.4 | Add a `macos-latest` unit job. macOS is the primary platform and has no CI at all. | S | bridge + ui unit suites green on macOS |
| P0.5 | Add `.gitattributes` forcing LF for `*.sh` and hook assets. | S | `git ls-files --eol` check in the unit job |
| P0.6 | Make the two early-return win32 tests use `skip` so skipped coverage is visible. | S | unit job |

### Phase 1 — Linux and WSL2 first-class

| ID | Task | Size | Gate |
|---|---|---|---|
| P1.1 | Session shell resolver: one function that picks `/bin/zsh`, else `$SHELL` if bash/zsh, else `/bin/bash`, used by `tmux.ts:147`, `direct-shell.ts:17`, `harness-registry.ts:374`. Decide the bash login semantics (`bash -lc` reads `.profile`/`.bash_profile`). | M | `unit-minimal` runs a real direct and tmux launch under bash; unit with zsh unchanged |
| P1.2 | `ftown setup` preflight: detect tmux, git, jq, curl, a usable shell; print per-distro install hints; fail hard only on what is required. Surface the same in `ftown doctor`-style output if one exists. | M | unit tests with a faked PATH; `unit-minimal` asserts the message |
| P1.3 | Remove `jq`/`curl` from the hot path: port `notify.sh`, the grok hook, the antigravity hook and the muse helper to a Node entry point (`ftown-harness hook <kind>`), keeping the shell files as thin `exec` wrappers. Four independent tasks, one per hook, after a shared contract for the entry point. Also quotes the hook command path. | L (4 × M) | existing hook tests + `unit-minimal` (no jq) proving events arrive |
| P1.4 | PATH install for more shells: write `~/.profile` when no `.bashrc`, and fish `conf.d`. | S | `ensure-ftown-path.test.ts` cases |
| P1.5 | Honour `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME` for opencode and muse paths, and `CLAUDE_CONFIG_DIR`/`CODEX_HOME` for claude and codex. One task per harness (4 × S). | S each | unit tests per installer with env overrides |
| P1.6 | Replace `/tmp` literal in `harness-commands.ts:443` with `tmpdir()`. | S | unit |
| P1.7 | Grok quota refresh on Linux: use util-linux `script -qc` and PATH lookup instead of absolute BSD paths, then lift the darwin gate. | M | unit with a fake `script`; manual check on Linux |
| P1.8 | Verify and document the claude credentials file on Linux; make the "not signed in" message name the path looked at. | S | unit; manual check |
| P1.9 | WSL2 detection (`/proc/version` contains `microsoft`): correct the Solo LAN banner, and warn when the workdir is under `/mnt/`. | S | unit with injected probe |
| P1.10 | Docker Solo: build the checked-out bridge source, keep the Compose image tag aligned with `bridge/package.json`, document uid mapping, and verify linux/amd64 + linux/arm64 with buildx. | M | `docker-solo` asserts the installed bridge package and Compose tag versions, builds both arches, and boots amd64 to healthy |
| P1.11 | UI: accept Ctrl+Enter in `NewSessionModal`, show the right hint. | S | vitest component test |
| P1.12 | Replace the UI's `python3` heredoc snippets with a bridge RPC that lists sessions in Node. Removes the python3 prerequisite and a Windows blocker. One task per picker (2 × M). | M each | bridge unit + existing e2e picker specs |
| P1.13 | Document Linux and WSL2 as supported in the README with prerequisites. Depends on P1.1–P1.3. | S | docs review |

Exit criteria for phase 1: `unit`, `unit-minimal`, `e2e` and `docker-solo` required and
green on ubuntu; a manual pass on one WSL2 machine (setup, one session per installed
harness, Solo from a Windows browser via `localhost`).

### Phase 2 — decide on native Windows

One M-sized spike, run on a real Windows machine, answering the unknowns before any port
is scheduled:

- Do `node-pty` and `node-datachannel` install without a compiler (from P0.3)?
- Which harness CLIs have a native Windows build, what is the binary called, and where is
  its config? Several may be WSL-only upstream, which would cap the value of the port.
- Does Claude Code use the same project-dir slug on Windows?
- How does each harness execute a hook command on Windows (cmd, PowerShell, direct exec)?
- Does the PowerShell direct runtime launch and deliver a prompt for at least one harness?

Outcome: either "WSL2 is the Windows story" (document it, close phase 3) or a go for
phase 3 with the harness list narrowed to those that exist natively.

### Phase 3 — native Windows port (only if phase 2 says go)

| ID | Task | Size | Gate |
|---|---|---|---|
| P3.1 | Binary resolver: one `resolveBinary(name)` that searches PATH with `PATHEXT`, replaces every `command -v` probe (`codex-installer.ts:48`, `opencode-plugin-installer.ts:12`, `muse-plugin-installer.ts:57`) and bare-name spawn, and handles `.cmd` shims. | M | unit on all three OS with fake PATH dirs |
| P3.2 | Launchers: emit `.cmd` shims beside the bash launchers; PATH registration via the user environment. | M | windows job runs `ftown --version` through the shim |
| P3.3 | Skills: fall back from symlink to directory junction, then copy; make `setup-state.ts:44` accept all three. | M | windows job runs `ftown setup` to "ready" without Developer Mode |
| P3.4 | Hooks on Windows: register the Node entry point from P1.3 directly (depends on P1.3, P3.1). One task per harness. | M each | windows job: fake harness fires a hook, bridge receives it |
| P3.5 | Launch strings: build harness commands from structured argv and render per shell, removing `"$HOME/..."` literals (`harness-registry.ts:206`, `:231`). | M | `harness-registry.test.ts` snapshot per platform; windows launch proof |
| P3.6 | Process control: verify pty kill on Windows, replace group kills with a tree kill, add a shutdown path that does not rely on SIGTERM. | M | windows job: start and stop a session, no orphan process |
| P3.7 | Worktrees: reject reserved names in the slug, compare paths case-insensitively on win32, set `core.longpaths` on created worktrees, retry removal on lock. Four S tasks. | S each | unit; windows job creates and retires a worktree |
| P3.8 | Quota: `.exe` candidates for agy, grok, opencode; credentials lookup for claude on Windows. One per provider. | S each | unit with fixture homes |
| P3.9 | Solo: add `windows-amd64` hub triple and digest, `.exe` naming, pid handling. | M | windows job boots Solo to "Connected" |
| P3.10 | Test portability: tag POSIX-only tests with a shared `posixOnly` skip helper, port the cheap ones (`/tmp` → `tmpdir()`), then run the full bridge suite on Windows. | L | `windows-latest` full unit job promoted to required |
| P3.11 | Self-update on Windows (`npm.cmd`, PATH separator, path containment with `sep`). Lowest priority; stays disabled until done. | M | windows update smoke |

### CI matrix at each stage

| Job | Now | After phase 0 | After phase 1 | After phase 3 |
|---|---|---|---|---|
| unit, ubuntu (zsh+tmux+jq) | required, launch proof skipped | required, nothing skipped | required | required |
| unit-minimal, ubuntu (bash only) | — | informational | required | required |
| unit, macos | — | required | required | required |
| e2e, ubuntu (3 shards) | required | required | required | required |
| docker-solo, amd64+arm64 | — | — | required | required |
| windows smoke | — | informational | informational | replaced |
| unit, windows | — | — | — | required |
| Solo e2e, windows | — | — | — | informational, then required |

WSL2 cannot be exercised on hosted runners in a way that is worth maintaining. It is
covered by the Linux jobs plus the manual pass in the phase 1 exit criteria; the
WSL-specific logic (P1.9) is unit-tested behind an injected probe.

## Open questions for the maintainer

1. Is native Windows a goal, or is "Windows via WSL2 or Docker" acceptable? This decides
   whether phase 3 (roughly four to six weeks of small tasks) is ever scheduled.
2. Should bash be a supported session shell (P1.1), or should ftown simply require zsh and
   say so at setup? Requiring it is a one-day change; supporting bash changes which rc
   files load and therefore PATH behaviour for every harness.
3. Is porting the hooks to Node (P1.3) acceptable given hooks currently work without Node
   startup cost on every event? It removes two undeclared dependencies and is the
   prerequisite for Windows.
