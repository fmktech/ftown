# ftown scheduled loops

Use this skill to manage bridge-owned recurring session producers. Each loop
stores a schedule, harness, task prompt, optional shell preflight/postflight
hooks, overlap policy, and retention. Every fire creates a normal ftown session
tagged with `loopId` and grouped under the loop in the dashboard.

Prefer loops for unattended recurrence over sleeping/polling inside a long-lived
agent. Prefer `ftown-workflows` for deterministic control flow inside one run.

## CLI

The bridge installs loop commands through `~/.ftown/ftown-sessions loop ...`.
The unified skill also bundles `scripts/ftown`, which delegates to the top-level
`~/.ftown/ftown` dispatcher.

```bash
CLI=~/.ftown/ftown-sessions

# List loops
$CLI loops
$CLI loop list --plain

# Create an interval loop
$CLI loop create \
  --name repo-watch \
  --every 30m \
  --shell codex \
  --workdir /path/to/repo \
  --task "Inspect recent changes, run the focused checks, and report issues" \
  --retention 10

# Create a cron loop
$CLI loop create \
  --name weekday-triage \
  --cron "0 9 * * 1-5" \
  --tz America/New_York \
  --task "Triage new issues and summarize priority"
```

## Common Operations

```bash
# Inspect
~/.ftown/ftown-sessions loop get <loop-id>
~/.ftown/ftown-sessions loop runs <loop-id>

# Manual fire; skip-policy loops refuse this while a prior run is still alive
~/.ftown/ftown-sessions loop run <loop-id>

# Pause / resume
~/.ftown/ftown-sessions loop pause <loop-id>
~/.ftown/ftown-sessions loop resume <loop-id>

# Update schedule, prompt, harness, retention, or runtime guard
~/.ftown/ftown-sessions loop update <loop-id> --every 1h --task "updated task"
~/.ftown/ftown-sessions loop update <loop-id> --retention all
~/.ftown/ftown-sessions loop update <loop-id> --max-runtime 20m

# Delete. Any in-flight run owned by the loop is stopped by the bridge.
~/.ftown/ftown-sessions loop delete <loop-id>
```

Running `loop run` (or the REST/RPC run-now trigger) against a loop that was
just deleted now fails with `not_found` instead of resurrecting it — a
run-now request never re-creates a deleted loop.

## Options

| Flag | Meaning |
| --- | --- |
| `--every <duration>` | Interval schedule such as `30s`, `5m`, `2h`, `1d`. Minimum is `1s`. |
| `--cron <expr>` / `--tz <zone>` | Cron schedule with optional IANA timezone. |
| `--shell <type>` | `claude`, `cursor`, `codex`, `opencode`, or `shell`. |
| `--workdir <path>` | Working directory for each run. |
| `--model <name>` | Harness model override when supported. |
| `--disabled` / `--enabled` | Create/update enabled state. |
| `--allow-overlap` / `--skip-overlap` | Allow concurrent runs, or skip while the previous run is alive. Default is skip. |
| `--retention <n|all>` | Keep newest N run sessions, or keep all. Default create value is `10`. |
| `--preflight <cmd>` | Shell guard before a run. Non-zero exit records `skipped` and spawns no session. |
| `--postflight <cmd>` | Shell hook after a run. Receives `FTOWN_RUN_STATUS`, `FTOWN_RUN_SESSION_ID`, and `FTOWN_RUN_OUTPUT`. |
| `--postflight-on-skip` | Also run postflight after a preflight skip. |
| `--max-runtime <duration>` | Force-stop a run and mark the loop error after this duration. |
| `--group <label>` | Optional label used by the UI to fold crons under Bridge → Group; pass `--group ""` on update to clear. |

## Notes

- `loop run` sets a one-shot manual request. It bypasses the enabled flag but
  still honors skip-overlap when the prior run is alive.
- `{{preflight}}` in the task prompt is replaced with preflight stdout, and the
  same stdout is available to the run as `FTOWN_PREFLIGHT_OUTPUT`.
- Loop state persists in `~/.ftown/loops.json` on the bridge machine. Anyone who
  can read `~/.ftown/bridge.json` can control loops through the local API.
