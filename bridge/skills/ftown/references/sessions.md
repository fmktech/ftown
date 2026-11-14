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

# Spawn a child agent (uses FTOWN_SESSION_ID for --parent; --require-green-pr blocks done until PR CI is green)
ftown sessions create \
  --prompt "Review the auth module and summarize" \
  --workdir /path/to/repo \
  --name auth-review \
  --require-green-pr \
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
# conversation when a claude/cursor/codex/Pi/grok/antigravity session id was recorded; Kimi Code
# continues by working directory; the revived session gets a NEW id)
ftown sessions revive <session-id>
```

## Status, board and events

Each session has a card: state (`working`, `blocked`, `waiting_review`,
`done`, `failed`), headline, optional progress, blocker and next step. Keep
your own card current at meaningful transitions, not every turn. Writing a
card wakes nobody. The target defaults to `FTOWN_SESSION_ID`; `--session-id
<id>` selects another session.

```bash
# Print my card
ftown status [--json] [--session-id <id>]

# Update my card (omitted fields unchanged; first write needs --state and --headline)
# --force bypasses --require-green-pr only when called by the session's parent (exits 5 on 409)
ftown status set [--state <s>] [--headline <t>] [--progress <d>/<t>|--no-progress] \
  [--on human|parent|external|session:<id>] [--text <t>] [--next <t>|--no-next] [--force] [--session-id <id>]

# Remove my card
ftown status clear [--session-id <id>]

# One line per child of my tree
ftown board [--json] [--since <n>] [--ready] [--all] [--session-id <id>]

# Wait until a board condition holds
ftown board [--wait --until any-change|any-done|any-blocked|all-done|any-ready [--timeout <s≤300>]] [--session-id <id>]

# Tree events for my tree (status, attention, pr, preview, exit, idle, result, mail, plan, removed)
ftown events [--json] [--since <n>] [--limit <n>] [--wait [--timeout <s≤300>]] [--session-id <id>]
```

`--ready` lists only children whose PR checks passed and who are not done;
`--all` includes retired (archived) children after the live ones, newest
first, capped at 50 and suffixed `(retired)` in plain output; `--since <n>`
limits the board to children with events after that cursor (the board
prints its cursor). Pass the cursor back as `--since` to see only what
changed. Plain board output appends a `planned` section after the child
rows: up to 5 ready plan items as `→ <id> <title>`, then `+N more` when
more are ready.

Tree events also include `plan` (one per plan change, summary
`<id> <state>: <title>`, plus ` → ready: <id>, …` when items become ready)
and `removed` (summary `removed`, when a child is removed or archived
while not already exited).

Exit codes for `status`, `board` and `events`: 0 ok, 1 error, 2 usage,
3 wait timed out with the condition unmet.

## Plan list

The plan is the manager's plan, not a ticket system: a todo list with
precedence stored on the manager (parent) session. It defaults to
`FTOWN_SESSION_ID`; `--session-id <id>` targets another session's plan.

```bash
# List in plan order (--json passes the PlanView through)
ftown plan [--json] [--session-id <id>]

# Add (title is the remaining words; precedence via --after/--priority)
ftown plan add <title...> [--note <t>] [--after <id,id>] [--priority 1|2|3] [--session-id <id>]

# Link an existing child, or set state directly
ftown plan start <id> --session <child-id> [--session-id <id>]
ftown plan done <id> [--session-id <id>]
ftown plan drop <id> [--session-id <id>]
ftown plan todo <id> [--session-id <id>]

# Edit or remove (removing strips the id from other items' after lists)
ftown plan edit <id> [--title <t>] [--note <t>|--no-note] [--after <ids>|--no-after] [--priority n] [--session-id <id>]
ftown plan rm <id> [--session-id <id>]

# Create a child for a plan item (marks it started, linked to the child)
ftown sessions create --parent --plan-item <id> --prompt "<task>"
```

List marks: `→` ready, `·` waiting, `▸` started, `✓` done, `✗` dropped,
printed as `<mark> <id> [P<priority>] <title>` plus `(after p1,p2)` or
`→ <child name>` when linked. Ordering is ready first, then waiting (both
by priority ascending, then creation time), then started, done and
dropped. An item is ready when it is `todo` and every item in its `after`
list is `done` or `dropped`; precedence is set only with `--after` and
`--priority` (1 is highest). Item ids are `p<n>` and are never reused.
Limits: 200 items, title 140 characters, note 500, at most 20 `after`
ids; `after` ids must exist, with no self-reference or cycles.

`--plan-item <id>` (on `ftown sessions create`, requires `--parent` or
`--parent-id`) fails with an error before any session is created when the
item is unknown or not `todo`; after creation the item becomes `started`
with the child linked, and a linking failure only warns (the session
stays). When a linked child's card becomes `done`, the item becomes
`done`; a `failed` card leaves it `started` for the manager to decide.
Setting an item back to `todo` clears its linked session. Exit codes for
`ftown plan`: 0 ok, 1 error, 2 usage.

## Manager brief

A coordinating session keeps a markdown brief plus timestamped notes; the
dashboard overview renders the brief, the last 10 notes and the session's
children automatically. The target defaults to `FTOWN_SESSION_ID`.

```bash
ftown brief show [--json] [--session-id <id>]
ftown brief set (--file <path.md> | --text <t> | --clear) [--session-id <id>]
ftown brief note <text...> [--session-id <id>]
```

Text is markdown, at most 16384 characters; a note is a single line of
1–280 characters; at most 50 notes are kept (oldest dropped). Control
characters except newline and tab are stripped; text over the limit is an
error (exit 1), never truncated.

## Worktrees

Children that write code can get a bridge-created git worktree. The default
branch is `ftown/<slug(name)>` at `<repoRoot>/.claude/worktrees/<slug(name)>`;
the base defaults to the current branch of the working directory (a detached
HEAD needs `--base`). Only bridge-created worktrees are ever removed.

```bash
ftown sessions create --parent --worktree [--branch <b>] [--base <ref>] [--workdir <dir>]
ftown sessions remove <id> [--keep-worktree | --force-worktree]
ftown worktrees list [--json]
ftown worktrees prune [--json]
```

On remove, a clean worktree whose branch is merged or fully pushed is
retired (worktree removed; the branch is deleted only when merged);
otherwise it is retained and the command prints why (for example
`worktree retained: 2 unpushed commits`). `--keep-worktree` always retains,
`--force-worktree` forces removal. `prune` applies the same rule to archived
sessions only.

## Preview session files

```bash
ftown sessions preview ./preview.html ./notes.md
ftown sessions preview --add ./extra.html
ftown sessions preview --remove notes.md
ftown sessions preview --clear
ftown sessions preview --session-id <id> ./preview.html ./notes.md
```

The target defaults to `FTOWN_SESSION_ID`. A session holds up to 12 files, in
registration order. Kind is by extension (case-insensitive): `.html`/`.htm` →
HTML, `.md`/`.markdown` → Markdown; anything else is rejected. Each file must
be UTF-8, at most 1 MiB, and inside that session's working directory; relative
paths resolve from the CLI's current directory. Two registered files may not
share a basename (the selector and links are by basename): a duplicate basename
is rejected with a clear error. Registration is all-or-nothing — if any path
fails validation or the set would exceed 12 files, nothing changes.

The four forms: `preview <path...>` replaces the whole set with these files;
`--add <path...>` appends to the current set; `--remove <name...>` removes by
basename (removing the last file clears the preview); `--clear` removes the
whole registration without deleting files. `--add`, `--remove`, and `--clear`
are mutually exclusive; no paths and no flag is a usage error. Use
`--session-id <id>` for an explicit target session.

HTML previews use a self-contained document: inline CSS and JavaScript and
data images are supported; sibling files and network access are not. Markdown
is rendered as a readable document with GFM (tables, task lists, strikethrough,
fenced code) inside the same sandbox iframe — no network, only `data:` images
— and raw HTML inside the markdown is isolated the same way as an HTML preview.
With two or more registered files, the dashboard shows a file selector in the
preview toolbar; a relative link between registered files (matching a
basename, ignoring `./`, query and `#fragment`) switches the selector instead
of opening the default behavior. Write a temporary file and rename it over the
registered file to publish a complete update; a reload resets the preview's own
interactive state. Closing the dashboard preview does not clear the
registration; `--clear` removes the registration without deleting the file.

Preview conversation input arrives through the session's existing ftown mail.
Post a tool-authored reply with:

```bash
ftown sessions preview-reply --message "The preview is ready."
ftown sessions preview-reply --message-file ./reply.txt
printf 'First line\nSecond line\n' | ftown sessions preview-reply --message-file -
```

The target defaults to `FTOWN_SESSION_ID`; `--session-id` selects an explicit
session. Replies are limited to 4096 UTF-8 bytes. Preserve the returned ID and
pass it with `--id <uuid>` alongside the same text when retrying an uncertain
result. A queued message does not mean an agent has read it.

## Ask the human or associate a pull request

```bash
# Request human input for this session (JSON {event} by default)
ftown sessions attention --message "Please review the migration plan" --title "Review requested"

# Ask a single-select question and block until the human answers (default timeout 600 s)
ftown sessions attention --title "Pick a database" --message "Which database should I use?" \
  --option Postgres --option SQLite --wait

# Multi-select without free text
ftown sessions attention --message "Which checks should run?" --option Lint --option Test --option Typecheck --multi --no-text

# Several questions (array or {"questions": [...]})
ftown sessions attention --message "Setup" --questions-json '[{"question":"Runtime?","options":["Node","Bun"]},{"question":"Notes?"}]'

# Check a question later (one GET; --wait long-polls)
ftown sessions attention-status <event-id>
ftown sessions attention-status <event-id> --wait --timeout 300

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
session/harness eligibility. For a parent-routed item, creation notifies only
the parent; the dashboard notice and push fire if it is escalated to the human.
Do not automatically retry an uncertain mutation.
Acknowledging/resolving an event never answers or approves a CLI prompt.

### Questions and answers

`--option <label>` is repeatable and builds one question whose message is the
`--message` text, with those labels as choices. `--multi` allows several choices
and `--no-text` disallows free text; without options the question is free text.
`--questions-json` takes an array of questions or `{ "questions": [...] }`, where
each question has `question`, optional `header`, `options` (strings or
`{label, description?}`, at most 8), `multiSelect` and `allowText`. It cannot be
combined with `--option`, `--multi` or `--no-text`. `--multi` and `--no-text`
need `--option`; `--timeout` needs `--wait`; `--wait` needs questions. Questions
require a bridge reporting `capabilities.attention.prompt === true`; otherwise
the command fails before writing and asks you to update the bridge.

`--wait` and `attention-status --wait` print `Waiting for an answer (attention <id>)...`
to stderr and poll until the item is resolved or the deadline (`--timeout`
`--timeout <s>`, 1..86400, default 600). Exit codes:

| Exit | Meaning |
|------|---------|
| 0 | Answered; the formatted answer is printed to stdout |
| 2 | Resolved without an answer (dismissed or otherwise closed) |
| 3 | Still pending (`attention-status` without `--wait`) |
| 124 | Timed out; check later with `attention-status <id> --wait` |
| 1 | Error, including invalid flags or JSON and transient failures after retries |

Without `--wait`, `attention` prints the event ID when questions are present, so
the agent can check later with `attention-status`.

Delivery: the human answers in the dashboard inbox. A live waiter (`--wait`,
or `attention-status --wait`) receives the answer
directly. If nobody is waiting, the answer is sent as ftown mail from "You"
(`fromName` "You", thread `attention:<id>`) whose body starts with
`[ftown attention answer id=<id>]`. Claude Code `AskUserQuestion` calls inside an
FTown session follow the same path and are answered from the dashboard inbox.
The terminal picker appears only if the human chooses "Answer in terminal" or
after an hour.

### Parent-first routing

When the asking session has a running parent, the request goes to the parent
first: the parent receives one waking escalation mail (`[ftown question ...]`)
naming the commands below, and the human's inbox shows the item greyed as
"with parent" (the human may still answer it). There is no timer; only the
parent, or the parent stopping while the item is open, moves it to the human.

```bash
# Open parent-routed questions from my children (plain: `<child> <eventId> <title>` plus options)
ftown attention list [--json]

# Answer a child's question (as the parent)
ftown attention answer <child-id> <event-id> (--option <n|label>... | --text <t> | --answers-json <json>) [--json]

# Raise it to the human instead (note at most 500 characters)
ftown attention escalate <child-id> <event-id> [--note <t>] [--json]

# Bypass the parent: only the human can provide this
ftown sessions attention --to human --message "Please paste the API token" --title "Credential needed"
```

Answer only from facts you hold — the plan, the agreed contract, earlier
human answers. Preferences and irreversible choices are escalated, not
answered. A parent answer is delivered exactly like a human answer (live
waiter, or mail whose sender is the parent session).

Exit codes for `ftown attention`: 0 ok, 1 error, 2 usage, 4 forbidden (the
caller is not the child's parent), 5 conflict (already resolved or already
escalated to the human).

PR links accept only HTTPS GitHub `/owner/repo/pull/<positive-number>` URLs.
Outer whitespace, query/fragment and a trailing slash are normalized; credentials,
nondefault ports and other paths/hosts are rejected. No GitHub request is made.
Attaching/replacing/clearing is metadata-only; omitting it on an update preserves
its value. New sessions/children do not implicitly inherit a parent's PR.

New commands probe the exact bridge capability before writing; update old bridges
with the exact version setup command in their readiness hint.

## Messaging (mail)

`tell` posts to the target session's **inbox**. Mail is delivered into the
recipient's context automatically (as `[ftown mail]` context), so there is no
keystroke injection by default. Claude and codex use turn-boundary hooks. Pi's
bundled extension keeps a cancellable long-poll open and starts a native
follow-up turn when mail arrives, including while Pi is idle. opencode's
installed plugin delivers pending mail as a new prompt when a turn goes idle.
Muse's installed `ftown` plugin reports the native session id on SessionStart
and pumps pending mail as context on Stop.
Grok's ftown hooks (`~/.grok/hooks/ftown.json`) report the native session id
and deliver mail that arrives mid-turn when the turn ends; the typed nudge
remains the fallback for an idle Grok agent.
Antigravity's ftown Stop hook (`~/.gemini/config/hooks.json`, entry `ftown`)
reports the conversation id and delivers mail at turn end.
Grok and Antigravity hooks do not run in the interactive TUI until the folder
has been trusted in that CLI's own trust prompt; the owner answers it once per
folder, and ftown does not bypass it.
Cursor and shell sessions rely on a one-line nudge to run `ftown harness
mail read` instead. Each new batch of mail nudges the recipient at most once;
un-read mail stays in the inbox. Mail types are `message`, `task`, `result`,
`escalation` and `fyi`; `fyi` is for non-urgent notes and never wakes the
recipient. Progress and status go on the session card (see above), never as
mail.

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
| `--shell` | Explicit harness override: `claude`, `cursor`, `codex`, `grok`, `muse`, `antigravity`, `pi`, `kimi-code`, `opencode`, `shell`, or Claude Code provider flavors `zai`, `kimi`, `deepseek`, `fireworks`. When omitted inside a session, inherits that session's harness; outside a session, defaults to `claude`. |
| `--prompt` | Initial task — passed as a CLI launch argument to `claude`/Claude provider flavors/`cursor`/`codex`/`grok`/`muse`/`antigravity`/`pi` (typed after boot for other shells) |
| `--workdir` | Working directory |
| `--name` | Dashboard label |
| `--command` | Full command override (skips `--shell` builder) |
| `--parent` | Set parent to `$FTOWN_SESSION_ID` |
| `--parent-id` | Explicit parent session UUID |
| `--plan-item <id>` | Do plan item `p<n>` of the parent (requires `--parent` or `--parent-id`; see Plan list) |
| `--worktree` | Create a bridge-owned git worktree for the session (see Worktrees) |
| `--branch <b>` | Worktree branch (requires `--worktree`; default `ftown/<slug(name)>`) |
| `--base <ref>` | Ref the worktree branch starts from (requires `--worktree`) |
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

ftown board --wait --until any-done --timeout 300
ftown board
ftown sessions grep <child-id> --pattern 'FAIL|Error'
```

### Completion handoff

A top-level session (no parent): when the task creates or updates a GitHub PR,
associate its actual URL with the FTown session before the completion notice.
Then request user attention once the task is complete, before the final handoff. Replace the sample URL and summary
below with truthful outcomes and checks (including checks not run):

```bash
ftown sessions pr https://github.com/owner/repo/pull/123
ftown sessions attention --title 'Work complete' \
  --message 'Outcome: <actual result>. Checks: <actual results or not run>. PR: https://github.com/owner/repo/pull/123'
```

For tasks without a PR, omit the PR command and PR summary. Use the verified
`FTOWN_SESSION_ID` or explicit `--session-id`; never guess a target.

Send one completion request per completed task, not repeated per-turn notices.
Logical duplicate coalescing does not justify retries after an uncertain outcome;
inspect the existing request first, as described above. Child agents do not
raise "Work complete": they set their card to `done` and send their assigned
result to the parent, and the parent raises one completion notice for the
whole job.

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
| POST | `/api/sessions/:id/attention` | Request input (`{ message, title?, questions?, to?: 'human' }`) → `{ event }`; invalid `questions` → 400 `invalid_prompt` |
| POST | `/api/sessions/:id/attention/:eventId/answer` | Parent answers a child (`{ answers }`); 403 not the parent, 409 resolved |
| POST | `/api/sessions/:id/attention/:eventId/escalate` | Parent raises it to the human (`{ note? }`); 403 not the parent, 409 already human/resolved |
| GET | `/api/sessions/:id/attention/routed` | Open parent-routed items of my children → `{ items }` |
| GET/PUT/DELETE | `/api/sessions/:id/brief` | Read, set/clear (`{ text: string \| null }`) or delete the manager brief |
| POST | `/api/sessions/:id/brief/notes` | Append a brief note (`{ text }`) |
| GET | `/api/sessions/:id/plan` | Read the plan (`PlanView`: ordered items plus ready ids) |
| POST | `/api/sessions/:id/plan` | Add a plan item (`{ title, note?, after?, priority? }`) → `{ item }` |
| PATCH | `/api/sessions/:id/plan/:itemId` | Edit a plan item (`{ title?, note?: string\|null, after?, priority?, state?, sessionId?: string\|null }`) → `{ item }`; item id is `p<n>` |
| DELETE | `/api/sessions/:id/plan/:itemId` | Remove a plan item (strips it from other items' `after`) → `{ ok: true }` |
| GET | `/api/worktrees` | List bridge-owned worktrees with git status |
| POST | `/api/worktrees/prune` | Retire eligible archived worktrees → `{ removed, retained }` |
| GET | `/api/sessions/:id/attention/:eventId` | Read one item (`?waitSeconds=0..25` long-polls until resolved) → `{ event }`; 404 `attention_not_found` |
| POST | `/api/sessions/:id/attention/ask` | Harness hook: record an AskUserQuestion (`{ toolName, toolUseId, toolInput }`) → `{ event }` or `null` if not promptable |
| GET | `/api/sessions/:id/screen` | Terminal lines |
| POST | `/api/sessions/:id/grep` | Search |
| POST | `/api/sessions/:id/keys` | Send keys |
| GET | `/api/sessions/:id/running` | PTY liveness |
| POST | `/api/sessions/:id/inbox` | Send mail (`{ body, from?, fromName?, type?, threadId? }`) |
| GET | `/api/sessions/:id/inbox` | Read mail (`?wait=&peek=&limit=&all=`) |
| POST | `/api/sessions/:id/message` | Inject a message line as keystrokes (`{ text, from? }`) |
| PUT | `/api/sessions/:id/preview` | Replace or add preview files, local CLI only (`{ paths: string[], mode: 'replace' \| 'add' }`) |
| DELETE | `/api/sessions/:id/preview` | Remove preview files by name or clear the preview, local CLI only (`{ names?: string[] }`; absent names clears all) |
| DELETE | `/api/sessions/:id` | Remove (tombstone-archived; `?worktree=keep\|force` overrides worktree retirement) |
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

An unpaired `ftown start` prints a `/pair` link and a 6-digit code: open the link on a device with the
account passkey and type the code. A computer removed from the account resets its own identity, keeps its
tmux sessions, and shows a new pairing link; `ftown start --new-identity` does the same by hand.

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
