# ftown cross-session CLI

Use `ftown sessions`, installed by explicit `ftown setup` before the bridge starts. It reads `~/.ftown/bridge.json` automatically.

```bash
ftown sessions --help
```

Unified skill wrapper: `scripts/ftown` in this skill directory delegates to the
top-level `~/.ftown/ftown` dispatcher.

**Trust model:** anyone who can read `bridge.json` can control **every** ftown session on that bridge.

## Commands

```bash
# List sessions (JSON)
ftown sessions list

# Spawn a child agent (uses FTOWN_SESSION_ID for --parent)
ftown sessions create \
  --prompt "Review the auth module and summarize" \
  --workdir /path/to/repo \
  --name auth-review \
  --parent

# Metadata
ftown sessions get <session-id>

# Terminal output (JSON by default; add --plain for raw lines)
ftown sessions screen <session-id> --limit 200

# Search output (--offset/--limit paginate screen and grep)
ftown sessions grep <session-id> --pattern 'error|failed' --offset 0 --limit 100

# Type into another running session
ftown sessions keys <session-id> 'y'

# Liveness
ftown sessions running <session-id>

# Stop and remove a session (kept as a tombstone in the archive)
ftown sessions remove <session-id>

# List archived (removed) sessions: id, name, removedAt, shellType
ftown sessions archive

# Recreate a removed session from its tombstone (resumes the agent
# conversation when a claude/cursor/codex/Pi session id was recorded; Kimi Code
# continues by working directory; the revived session gets a NEW id)
ftown sessions revive <session-id>
```

## Preview session HTML

```bash
ftown sessions preview ./preview.html
ftown sessions preview --session-id <id> ./preview.html
ftown sessions preview --clear
```

The target defaults to `FTOWN_SESSION_ID`. The file must be a UTF-8 `.html` or
`.htm` file of at most 1 MiB inside that session's working directory. Relative
paths resolve from the CLI's current directory. Use a self-contained document:
inline CSS and JavaScript and data images are supported; sibling files and
network access are not. Write a temporary file and rename it over the registered
file to publish a complete update. Closing the dashboard preview does not clear
the registration; `--clear` removes the registration without deleting the file.

## Ask the human or associate a pull request

```bash
# Request human input for this session (JSON {event} by default)
ftown sessions attention --message "Please review the migration plan" --title "Review requested"

# Set or replace this session's single GitHub PR link (JSON {session})
ftown sessions pr https://github.com/owner/repo/pull/123

# Clear the association
ftown sessions pr --clear

# Explicit target overrides FTOWN_SESSION_ID for either command
ftown sessions attention --session-id <id> --message "Which approach should I take?"
ftown sessions pr --session-id <id> https://github.com/owner/repo/pull/123
```

Both commands use trimmed `FTOWN_SESSION_ID` when `--session-id` is omitted;
missing/invalid identity, empty/oversized text, malformed URLs and contradictory
arguments fail before transport. There is no working-directory or latest-session
fallback. Title is optional (default `Session needs your input`, max 200 characters);
message is required (max 2000). Controls and common credentials are sanitized.
`--plain` prints a concise success summary. `--help` is read-only.

Attention persists an `agent_needs_input` event, returns its exact ID and updates
the existing dashboard attention flow. Logical duplicate unresolved requests
coalesce while recording occurrences; resolving it permits a new incident.
Only creation triggers notification, and hosted push remains opt-in with existing
session/harness eligibility. Do not automatically retry an uncertain mutation.
Acknowledging/resolving an event never answers or approves a CLI prompt.

PR links accept only HTTPS GitHub `/owner/repo/pull/<positive-number>` URLs.
Outer whitespace, query/fragment and a trailing slash are normalized; credentials,
nondefault ports and other paths/hosts are rejected. No GitHub request is made.
Attaching/replacing/clearing is metadata-only; omitting it on an update preserves
its value. New sessions/children do not implicitly inherit a parent's PR.

New commands probe the exact bridge capability before writing; update old bridges
with the exact version setup command in their readiness hint. For remote MCP,
`attention_request` requires explicit `{machine, sessionId, message, title?}` and
returns `{machine, sessionId, event}`. `sessions_update` accepts `pullRequestUrl`
(string or null), alongside existing name/parent fields. A mixed PR+name update
rejects an old bridge before changing either field. Read-only MCP clients cannot
see these mutation tools; control authorization and machine ownership still apply.

## Messaging (mail)

`tell` posts to the target session's **inbox**. Mail is delivered into the
recipient's context automatically (as `[ftown mail]` context), so there is no
keystroke injection by default. Claude and codex use turn-boundary hooks. Pi's
bundled extension keeps a cancellable long-poll open and starts a native
follow-up turn when mail arrives, including while Pi is idle. opencode's
installed plugin delivers pending mail as a new prompt when a turn goes idle.
Muse's installed `ftown` plugin reports the native session id on SessionStart
and pumps pending mail as context on Stop.
Cursor and shell sessions rely on an idle one-line nudge to run `ftown harness
mail read` instead.

```bash
# Tell a specific session
ftown sessions tell <session-id> "tests are green, ship it"

# Mail type / threading
ftown sessions tell <session-id> --type task "implement the API client"
ftown sessions tell <session-id> --type result --thread <id> "done, 0 failures"

# Tell my parent / children / siblings (resolved via FTOWN_SESSION_ID)
ftown sessions tell --parent "child finished phase 1"
ftown sessions tell --children "pause and report status"
ftown sessions tell --siblings "I grabbed the lock, stand by"

# Last resort: inject as terminal keystrokes instead of mail
ftown sessions tell <session-id> --keys "wake up"

# Read my own inbox (requires FTOWN_SESSION_ID; alias: mail)
ftown sessions inbox            # --peek / --limit N / --all / --json
```

Sender is resolved from `FTOWN_SESSION_ID` (omitted when unset).
Fan-out targets are messaged sequentially, one JSON result line per target.

### Create options

| Flag | Description |
|------|-------------|
| `--shell` | Explicit harness override: `claude`, `cursor`, `codex`, `grok`, `muse`, `pi`, `kimi-code`, `opencode`, `shell`, or Claude Code provider flavors `zai`, `kimi`, `deepseek`, `fireworks`. When omitted inside a session, inherits that session's harness; outside a session, defaults to `claude`. |
| `--prompt` | Initial task — passed as a CLI launch argument to `claude`/Claude provider flavors/`cursor`/`codex`/`grok`/`muse`/`pi` (typed after boot for other shells) |
| `--workdir` | Working directory |
| `--name` | Dashboard label |
| `--command` | Full command override (skips `--shell` builder) |
| `--parent` | Set parent to `$FTOWN_SESSION_ID` |
| `--parent-id` | Explicit parent session UUID |
| `--model` | Harness model name or provider/model pattern (when supported) |

Provider-flavored shells (`zai`, `kimi`, `deepseek`, `fireworks`) run Claude
Code with provider-specific default endpoint/model environment. They require a
machine token on the bridge host, e.g. `ftown env set zai <token>`.

Returns JSON with the new `session.id` — use that id for `screen` / `grep` / `keys`.

## Typical workflow

```bash
ftown sessions list
ftown sessions create --prompt "Run tests and report" --workdir "$PWD" --parent
# -> note session.id from JSON

ftown sessions screen <child-id> --limit 100
ftown sessions grep <child-id> --pattern 'FAIL|Error'
```

### Completion handoff

When the task creates or updates a GitHub PR, associate its actual URL with the
FTown session before the completion notice. Then request user attention once the
task is complete, before the final handoff. Replace the sample URL and summary
below with truthful outcomes and checks (including checks not run):

```bash
ftown sessions pr https://github.com/owner/repo/pull/123
ftown sessions attention --title 'Work complete' \
  --message 'Outcome: <actual result>. Checks: <actual results or not run>. PR: https://github.com/owner/repo/pull/123'
```

For tasks without a PR, omit the PR command and PR summary. Use the verified
`FTOWN_SESSION_ID` or explicit `--session-id`; never guess a target. MCP callers
instead use `sessions_update` with `pullRequestUrl` when applicable, then
`attention_request` with title `Work complete` and the same truthful summary,
always supplying explicit `machine` and `sessionId`.

Send one completion request per completed task, not repeated per-turn notices.
Logical duplicate coalescing does not justify retries after an uncertain outcome;
inspect the existing request first, as described above. Child agents still send
their assigned result to the parent; the user attention request is additional.

## Environment

Spawned ftown sessions receive:

- `FTOWN_SESSION_ID` — this session (use with `--parent`)
- `FTOWN_PARENT_SESSION_ID` — the parent session id, set on children spawned with `--parent` / `--parent-id`
- `FTOWN_HOOK_PORT` / `FTOWN_HOOK_TOKEN` — hook forwarding (not for cross-session control)

Agent children (any `--shell` except `shell`) spawned with a parent also get an
automatic one-paragraph briefing prepended to their first input: it states their
name/id and parent name/id. It explains how to report via
`ftown harness mail send --parent --type result` (or `--type escalation` when blocked).
The creator's `--prompt` follows after a `Task:` line. Session cleanup is an
explicit user or orchestrator action; see the ftown skill.

A task and optional parent link are sufficient for coordination. Legacy
`--orchestrator` and request booleans are accepted as ignored compatibility inputs;
there is no role briefing or injected role environment. Explicit user-supplied
environment variables remain untouched.

## HTTP API (optional)

The CLI wraps the loopback API. Raw access if needed:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sessions` | List |
| POST | `/api/sessions` | Create |
| PATCH | `/api/sessions/:id` | Rename, move or associate a PR (`{ name?, parentSessionId?, pullRequestUrl? }`; `null` detaches/clears) |
| POST | `/api/sessions/:id/attention` | Request human input (`{ message, title? }`) → `{ event }` |
| GET | `/api/sessions/:id/screen` | Terminal lines |
| POST | `/api/sessions/:id/grep` | Search |
| POST | `/api/sessions/:id/keys` | Send keys |
| GET | `/api/sessions/:id/running` | PTY liveness |
| POST | `/api/sessions/:id/inbox` | Send mail (`{ body, from?, fromName?, type?, threadId? }`) |
| GET | `/api/sessions/:id/inbox` | Read mail (`?wait=&peek=&limit=&all=`) |
| POST | `/api/sessions/:id/message` | Inject a message line as keystrokes (`{ text, from? }`) |
| DELETE | `/api/sessions/:id` | Remove (tombstone-archived) |
| GET | `/api/archive` | List removed-session tombstones |
| POST | `/api/sessions/:id/revive` | Recreate a removed session (new id) |

To move a session under a different parent, PATCH it with the new parent's id:

```json
{ "parentSessionId": "new-parent-session-id" }
```

Set `parentSessionId` to `null` to detach it from its current parent and move it
back to the bridge root. Parent and child must belong to the same bridge.

## If the CLI is missing

Run `npx ftown@<version> setup`, using the
version in the bridge readiness hint. This works before the installed alias
exists and installs the `ftown` command, compatible
launchers, `~/.ftown/notify.sh`, and updates the unified skill
under `~/.ftown/skills/ftown/` (linked into ~/.agents/skills and
~/.claude/skills).

### Automatic PR result mail

A PR linked to an agent session is monitored by the running bridge using the local
`gh` account. Observed current-head GitHub rollup failures, successes, and merges
arrive as durable FTown mail, including the PR and checks links. Pending checks are
typically polled at one minute and completed checks at five minutes; quota, auth or
offline delays apply, and changes between polls may not be observed. Clear the link
to stop future observations. Durable enqueue does not guarantee agent processing.
Already-stopped agents are not restarted; their mail remains
queued. A delivery admitted before a stop can finish during that stop. A result notification is a fact, not authorization to merge or take other
actions. Plain shell sessions are not monitored as agents.
