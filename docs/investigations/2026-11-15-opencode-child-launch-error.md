---
type: investigation
symptom: "ftown opencode child sessions go to status error immediately after launch when a model is set"
slug: opencode-child-launch-error
date: 2026-11-15T13:24:26-03:00
investigator: Foad Kesheh
git_commit: dbed585f74bf45929a5a2557c46bbfb7eaa72839
branch: feat/opencode-launch
repository: fmktech/ftown
status: resolved
hypotheses_formed: 4
hypotheses_rejected: 3
hypotheses_proven: 1
---

# Opencode child sessions error immediately after launch

## Symptom

User report, verbatim:

> Bug: ftown child sessions on the opencode shell go to status 'error' right after launch. Repro: ftown sessions create --parent --shell opencode --model opencode-go/kimi-k3.1-pro --workdir <dir> --prompt '<long multi-line prompt>' -> command was "opencode --auto -m 'opencode-go/kimi-k3.1-pro'", status error, error/exitCode/lastError null, screen blank (only clear-line escapes). The same model works via 'opencode run -m opencode-go/kimi-k3.1-pro "say ok"'.

- **Observed**: A model launch stores `opencode --auto -m 'opencode-go/kimi-k3.1-pro'` and the session status becomes `error` about one second later. The pane shows only the CLI usage dump. Archived records have no `error`, `exitCode`, or `lastError` fields. `errorReason` is set.
- **Expected**: The child stays running, the TUI accepts the prompt, activity can reach idle, and the requested model is selected. A real launch failure stores a non-null reason.
- **Delta**: The process exits 1 during flag parse, so the TUI never starts and idle is never reported. The parent looked up field names that the session record does not have; the reason is already on `errorReason`.

## Reproduction

Environment: macOS, `opencode` v2.3.0 at `~/.opencode/bin/opencode` (latest per the binary's own version), tmux at `/opt/homebrew/bin/tmux`. Investigation HEAD `dbed585f74bf45929a5a2557c46bbfb7eaa72839` on `feat/opencode-launch`. Private tmux sockets only (`-L` names prefixed `oc-`). The live `-L ftown` server was not used.

1. Archived ftown sessions that match the reported command (read 2026-11-15 from `~/.ftown/data/archive.jsonl`):

```
ID 06a35835-23c0-4c4a-b8fc-b05c9f4dddd0
  status='error'
  command="opencode --auto -m 'opencode-go/kimi-k3.1-pro'"
  createdAt='2026-11-15T14:32:49.140Z'
  updatedAt='2026-11-15T14:32:50.141Z'
  error/exitCode/lastError absent
  errorReason contains: Process exited with code 1 — ... ERROR(B Unrecognized flag: -m in command opencode Did you mean this? -c -s
```

The same shape is on `a303c42b-c6d2-4ae4-9af6-83ba0567691a` (created 2026-11-14T07:37:25.211Z, updated one second later).

2. The stored command, outside ftown, exits 1 before any TUI. Verified 2026-11-15T13:24-03:00:

```
$ opencode --version
opencode v2.3.0

$ opencode --auto -m 'opencode-go/kimi-k3.1-pro'; echo EXIT:$?
ERROR
  Unrecognized flag: -m in command opencode

  Did you mean this?
    -c
    -s
EXIT:1
```

Root `opencode --help` lists `--standalone`, `--auto`, `-c/--continue`, `-s/--session`, and `--prompt`. It does not list `-m` or `--model`.

`buildOpencodeCommand` appends that flag whenever `model` is non-blank (`bridge/src/harness-registry.ts` lines 170-172). `terminal-pump.ts` `handleError` (lines 351-364) sets `status = 'error'` and `errorReason` from `Process exited with code N` plus the ANSI-stripped terminal tail.

## Hypotheses

#### H1: Root `opencode` on v2.3.0 rejects `-m`, and ftown's launch command passes `-m` for every model session, so the process exits 1 during flag parse.

- **Layer**: dependency
- **Prediction**: If H1 is true, `opencode --auto -m '<model>'` exits 1 with `Unrecognized flag: -m in command opencode` with no ftown runner involved, and the archived `errorReason` contains that text. If H1 is false, the same argv stays up or fails with a different error after the TUI starts.
- **Verification method**: Run the stored argv directly. Compare with root `--help`. Read the archived `errorReason` and `buildOpencodeCommand`.
- **Evidence**:

```
bridge/src/harness-registry.ts:170-172
  if (options.model?.trim()) {
    parts.push('-m', shellQuote(options.model.trim()));
  }

$ opencode --auto -m 'opencode-go/kimi-k3.1-pro'; echo EXIT:$?
ERROR
  Unrecognized flag: -m in command opencode
  Did you mean this?
    -c
    -s
EXIT:1

archived errorReason (06a35835):
Process exited with code 1 — ... Unrecognized flag: -m in command opencode Did you mean this? -c -s
```

- **Verdict**: PROVEN
- **Rationale**: The flag error is produced by the opencode binary itself, the ftown command builder is what puts `-m` on the root argv, and the session record stores that exit as status `error`.

#### H2: The skills symlink added in #233 makes opencode exit during startup.

- **Layer**: config-env
- **Prediction**: If H2 is true, `opencode --auto` with the symlink present exits the same way, and the failure mentions the skill path. If H2 is false, a launch with no `-m` stays up while the symlink is present, and the `-m` failure happens before plugin or skill load.
- **Verification method**: Inspect the skill link. Launch `opencode --auto` (no `-m`) in a private tmux session and capture the pane.
- **Evidence**:

```
lrwxr-xr-x  ... ~/.config/opencode/skills/ftown -> ../../../.ftown/skills/ftown

private tmux, command `opencode --auto`, t=3s:
pane_dead=0
footer: Build auto · GLM-5.3-Flash OpenCode Go · high
banner: Plugin failed: ~/.config/opencode/plugins/ftown.js
```

The `-m` process prints usage and `Unrecognized flag` and never reaches plugin or skill load.

- **Verdict**: REJECTED
- **Rationale**: The skill link is present and a no-model TUI stays up. The failing argv dies at flag parse.

#### H3: The exit is caused by TUI startup inside tmux, by prompt-injection timing, or by the background opencode service.

- **Layer**: state-data
- **Prediction**: If H3 is true, the same `-m` argv succeeds outside tmux, or `opencode --auto` inside the same tmux setup also dies before drawing, or the pane dies only when `--prompt` is present. If H3 is false, `-m` fails outside ftown and outside tmux, and the same tmux draws a TUI and shows the prompt text when `-m` is absent.
- **Verification method**: Isolation run of the argv with no tmux and no ftown. Absence run of `opencode --auto` in private tmux. Counterfactual run with `--prompt` and no `-m`.
- **Evidence**:

```
no tmux, no ftown:
EXIT:1
Unrecognized flag: -m in command opencode

private tmux, `opencode --auto` (no -m, no --prompt):
pane_dead=0
footer drawn: Build auto · GLM-5.3-Flash OpenCode Go · high

private tmux, OPENCODE_CONFIG_CONTENT='{"model":"opencode-go/kimi-k3.1-pro"}' \
  opencode --standalone --auto --prompt 'Reply with the single word pong.':
pane_dead=0
pane text includes "Reply with th" (the prompt) and
"Build auto · Kimi K3.1 Pro OpenCode Go"
```

Prompt text is not on the stored command by design (`create-ftown-session.ts` persists the base command and adds `--prompt` only on the runner command). The death is the `-m` parse, about one second after create, before any keystroke injection.

- **Verdict**: REJECTED
- **Rationale**: Removing tmux, the prompt, and ftown still yields exit 1. The same tmux setup draws the TUI and shows the prompt once `-m` is gone. The background service does ignore client env (see falsification), but that changes the model footer, it does not exit the process.

#### H4: The installed plugin's default export fails v2 schema checks and that failure is what sets status error.

- **Layer**: dependency
- **Prediction**: If H4 is true, a launch that loads the plugin exits and the session error is the schema message. If H4 is false, the TUI stays up (`pane_dead=0`) while the plugin-failed banner is on screen.
- **Verification method**: Capture a live `opencode --auto` pane with the installed `~/.config/opencode/plugins/ftown.js` present.
- **Evidence**:

```
pane_dead=0
Plugin failed: /Users/fkesheh/.config/opencode/plugins/ftown.js
Build auto · GLM-5.3-Flash OpenCode Go · high
```

The same banner is on screen in the standalone prompt capture, and that process also stayed up. v2.3.0 wants a default export that is an object with an id and an effect or setup function. The installed file default-exports a function. That blocks Stop-to-idle from the real plugin. It does not exit the process.

- **Verdict**: REJECTED
- **Rationale**: The plugin banner and a live TUI occur together. Status `error` on the reported sessions is the flag exit, recorded before the TUI or the plugin loads.

## 5 Whys

```
Symptom:  Model opencode sessions flip to status error about one second after launch.
Why 1?    Because the process exits 1 and terminal-pump sets status error plus errorReason.
Why 2?    Because opencode v2.3.0 rejects -m on the root command.
Why 3?    Because buildOpencodeCommand still appends -m, the flag the v1 root TUI accepted.
Why 4?    Because the launch argv was frozen as a CLI contract, while v2 moved --model onto `run`, `mini`, and config. Root kept --auto, --prompt, and --session.
Why 5?    Because ftown assumes one stable argv means "interactive opencode plus a model", but v2 selects the model through config, and the background server does not inherit the client environment unless the client uses --standalone.
```

## Falsification

- **Check performed**: absence, isolation, and a counterfactual that removes the cause.
- **Absence**: `opencode --auto` with no `-m`, skill link present, plugin present, private tmux. `pane_dead=0` and the TUI footer is drawn. The bug does not occur when `-m` is absent.
- **Isolation**: `opencode --auto -m 'opencode-go/kimi-k3.1-pro'` with no ftown, no tmux, no prompt. Exit 1 and `Unrecognized flag: -m in command opencode`. The bug occurs when only the flag is present.
- **Counterfactual**: `OPENCODE_CONFIG_CONTENT='{"model":"opencode-go/kimi-k3.1-pro"}' opencode --standalone --auto --prompt 'Reply with the single word pong.'` in a private tmux. `pane_dead=0`, prompt text visible, footer `Build auto · Kimi K3.1 Pro OpenCode Go`.
- **Adjacent cause checked**: client env without `--standalone` does not select the model. Private tmux, same JSON in `OPENCODE_CONFIG_CONTENT`, command `opencode --auto` (no `--standalone`). `pane_dead=0`, footer stayed `Build auto · GLM-5.3-Flash OpenCode Go · high`. So `--standalone` is required for the env config to reach the server. It is not the reason the process exits.
- **Conclusion**: H1 survived. `opencode mini` accepts `-m` and rejects `--auto`, so it is not a substitute for the unattended root TUI. `opencode run -m` accepts the model and exits after one message, so it is not a long-lived session.

## Root Cause

- **Immediate cause**: `buildOpencodeCommand` passes `-m` on the root `opencode` argv (`bridge/src/harness-registry.ts:170-172`). opencode v2.3.0 does not accept that flag, exits 1, and `terminal-pump.ts` `handleError` records status `error`. Evidence: direct repro EXIT:1, archived `errorReason` for `06a35835-23c0-4c4a-b8fc-b05c9f4dddd0`.
- **Architectural root**: ftown treats "model" as an argv flag on the interactive command. v2 moved model selection to config (and to `run` / `mini`). The background server ignores the client environment, so the durable boundary is `--standalone` plus `OPENCODE_CONFIG_CONTENT`, while `--auto` and `--prompt` stay on the root command.
- **Rejected H2**: skill symlink is healthy and no-`-m` launches stay up.
- **Rejected H3**: the flag error happens with no tmux, no prompt, and no ftown. The TUI and `--prompt` work in that same tmux once `-m` is removed.
- **Rejected H4**: the plugin schema banner is visible while `pane_dead=0`. It is a follow-on for real Stop-to-idle, not this exit.
- **Field-name note**: `error`, `exitCode`, and `lastError` are not session fields. `errorReason` was already populated on both archived failures. The launch-failure regression still asserts `errorReason` is a non-empty string. No new notification channel.

## Fix

- `bridge/src/harness-registry.ts` `buildOpencodeCommand`: when `model` is non-blank, emit `opencode --standalone --auto` and do not emit `-m`. Resume with a model emits `opencode --standalone --auto --session '<id>'` and still suppresses `--prompt`. No model keeps `opencode --auto` and `opencode --auto --session '<id>'`.
- Export `opencodeLaunchEnv(model)` returning `{ OPENCODE_CONFIG_CONTENT: JSON.stringify({ model }) }` or undefined. `create-ftown-session.ts` merges it after `input.env` so the requested model wins and a caller PATH is kept. The tmux env file single-quotes values (`tmux.ts` `shellQuote`), so the JSON double quotes are safe.
- Do not write a project `opencode.json`. Do not switch the launch to `mini` or `run`.
- Regression: unit assertions for the new argv and env. An e2e launch of an opencode child through a fake `opencode` on the session PATH that stays running, records the `--prompt` argv, and reaches idle via Stop. A second launch that exits 1 records a non-null `errorReason`.
- Justification for the boundary mitigation: restoring root `-m` is an upstream CLI change (the flag is absent on the installed v2.3.0). Selecting the model through the config channel v2 already documents is the fix inside this repo. The plugin v2 schema port is out of scope; the idle regression uses the hook the session already exposes.

## Resolution

- `buildOpencodeCommand` emits `opencode --standalone --auto` when a model is set, and `opencode --standalone --auto --session '<id>'` on resume. It no longer passes `-m`. No-model launches stay `opencode --auto`.
- `opencodeLaunchEnv` stores `OPENCODE_CONFIG_CONTENT` as `{"model":"<trimmed>"}` on the session env after caller env, so resume and retry keep the model and a caller PATH is preserved.
- Regression: `bridge/src/harness-registry.test.ts`, `bridge/src/create-ftown-session.test.ts`, `bridge/src/opencode-launch.test.ts` (real tmux, fake `opencode` on the session PATH: prompt argv, idle via Stop, non-empty `errorReason` containing `Process exited with code 1`), and `e2e/tests/opencode-launch.spec.ts` for the same path through the bridge API.
- Verification: `bridge/src/opencode-launch.test.ts` passed locally (prompt receipt `argv: --standalone --auto --prompt say pong`, activity idle, failed launch `errorReason` matched `Process exited with code 1`). `npm run build` passed. The full bridge suite passed except seven `agent-commands` assertions that expect a bare command on a machine where `~/.ftown/claude-plugin` exists; that `--plugin-dir` insertion is pre-existing and outside this change. CI runners do not have that directory. The process test skips when tmux is absent, which is the unit CI image; `e2e/tests/opencode-launch.spec.ts` runs the same launch where CI installs tmux and zsh.
- Follow-up, out of scope: the installed plugin default-exports a function, and v2.3.0 wants an object with an id and a setup or effect. The TUI stays up and shows a plugin-failed banner. Real Stop-to-idle from that plugin needs a separate port. This launch regression posts Stop through the hook the session already exposes. Old stored commands that still contain `-m` relaunch verbatim.
