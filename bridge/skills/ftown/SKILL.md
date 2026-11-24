---
name: ftown
description: >-
  Control ftown sessions and multi-provider routing: sessions
  (create/list/read/drive, archive/revive/remove), worktrees, project discussions, and direct session mail.
  Choose bridges by capacity, transfer folders between paired computers, and
  launch workers under the same project across bridges.
  Handle human attention and questions routed to the parent first. Support
  HTML/Markdown previews, HTML preview replies, PR links, status cards and
  ftown board/events, the manager's plan list (ftown plan), and manager brief.
  Use quota/model routing for choosing CLI/model/effort across claude, codex,
  grok, muse, agy, omp and opencode (`ftown quota --json`). Use for ftown sessions,
  child/sibling agents, bridge mail/inbox, HTML preview, previews, worktrees,
  plan list, or orchestration.
---

# ftown

Setup points Claude and Codex to `~/.ftown/global.md` and `~/.ftown/bridge.md`. Use `ftown instructions show global|bridge --bridge <peer>` to read guidance over a paired direct link. Paired bridges automatically sync global guidance, with the newest edit winning on both machines. Use `ftown instructions sync global --bridge <peer>` for an immediate exchange. Bridge guidance stays local. In Computers, choose Edit agent instructions on the target bridge to edit either file.

Use `ftown start`, `ftown sessions`, `ftown harness`, and `ftown env`. Run `ftown --help`
for command discovery; if it is missing from PATH, use `~/.ftown/ftown`.
The bridge installs this skill at `~/.ftown/skills/ftown`, linked from
`~/.agents/skills`, `~/.claude/skills`, and the OpenCode skills directory
(`$OPENCODE_CONFIG_DIR/skills`, otherwise `$XDG_CONFIG_HOME/opencode/skills`,
or `~/.config/opencode/skills`). Startup checks setup readiness, including that
OpenCode link, and never rewrites global integrations. Before the installed
command exists, run setup from the package:

```bash
npx ftown setup
```

For upgrades, use the exact new version named by the startup readiness hint:

```bash
npx ftown@<new-version> setup
```

Start the bridge with `ftown start`; use `ftown start --solo` for a single-port
LAN deployment. `npx ftown start` accepts the same options, and `ftown-bridge`
remains compatible. `ftown start --help` only displays help. The installed alias
checks npm for a newer version before starting and runs its setup when available.
Use `--no-update` or `FTOWN_NO_AUTO_UPDATE=1` to skip the check; CI and Docker
Solo images skip it automatically. An offline check is skipped.
Use `ftown setup --repair` to repair that current copied version or detect new
optional harnesses. If the copied runtime is incomplete, use the matching package
entrypoint with `--repair`.

## Commands and references

```bash
ftown sessions list
ftown sessions create --prompt "Review the auth module" --workdir "$PWD" --parent
ftown sessions create --project "App" --shell claude --account personal --prompt "Review the auth module"
ftown sessions create --parent --allowed-accounts personal,work --prompt "Delegate account-scoped work"
ftown sessions screen <session-id> --limit 200
ftown sessions attention --message "Please review the migration plan" --title "Review requested"
ftown sessions attention --title "Pick a database" --message "Which database should I use?" --option Postgres --option SQLite --wait
ftown sessions attention-status <event-id> --wait
ftown sessions pr https://github.com/owner/repo/pull/123
ftown sessions pr --clear
ftown sessions preview ./preview.html ./notes.md
ftown sessions preview --add ./extra.html
ftown sessions preview --remove notes.md
ftown sessions preview --clear
ftown sessions preview-reply --message "The preview is ready."
ftown status set --state working --headline "Reviewing the API client" --progress 0/1
ftown board
ftown plan
ftown plan add "Review the API client" --after p1 --priority 1
ftown sessions create --parent --plan-item p2 --require-green-pr --prompt "Review the API client"
ftown brief set --file brief.md
ftown attention list
ftown worktrees list
ftown discuss reply <thread-id> --project App --text "Reviewed the API client"
ftown harness mail send <session-id> --type task "review the API client"
ftown harness mail read
ftown sessions handoff <session-id> --shell grok --model fast
ftown env --help
ftown accounts list [--json]
ftown accounts add personal --harness claude --config-dir "$HOME/.claude-personal" --label Personal
ftown accounts remove personal
ftown setup --help
ftown start --help
```

## Other computers (cross-bridge control)

Every computer paired to your account is a bridge. `ftown bridges` lists the
others (`--probe` shows which answer). Add `--bridge <name|id|id-prefix>`, or
set `FTOWN_BRIDGE`, to run `sessions`, `status`, `board`, `events`,
`attention`, `brief`, `worktrees` and `plan` commands on another bridge:

```bash
ftown bridges --probe
ftown bridges --resources --json
ftown sessions list --bridge my-laptop
ftown sessions create --bridge my-laptop --project "App" --shell codex --workdir /srv/app --prompt "Run the test suite"
ftown sessions screen <session-id> --bridge my-laptop --limit 100
```

The first command to another bridge goes through the relay and opens a direct
link to it; later commands use that link (`ftown bridges` marks it `direct`).
If no direct link can be made, commands keep using the relay.

Use `ftown bridges --resources --json` to choose a host. Compare the local `resources` with each entry’s `peers[].resources`. Check `cpuPercent` (average utilization between samples), `freeRamBytes`, `totalRamBytes`, `freeDiskBytes` (bridge data volume), and `sampledAt` (Unix milliseconds). A null reading means unknown capacity. The dashboard’s new-session picker refreshes these readings every 15 seconds while open. The caller chooses the destination.

The dashboard’s **Create project** selects a home bridge and creates one SQLite database per hosted project. Use **Board** beside a legacy project to choose its home. Boards route writes to that home; workers can run on any allowed bridge. Open a ticket to link sessions or launch a worker. Outstanding attention is shown on the ticket and appears in the board’s Blocked column when present. Paired bridges exchange the project directory; an offline home leaves a previously viewed board readable from the client cache.

Click a ticket title to edit its description, assign it to yourself or a paired bridge, add comments, and create subtasks. Each subtask has its own stage, assignee and linked workers. Drag a card to a column or use its stage selector. Linked sessions show their last reported status. On the default board, running work advances a ticket from **Backlog** to **In progress**. Renaming those columns preserves that automation. Removing either column disables the transition. New tickets start in the first column.

Assigning a ticket to a bridge or changing its stage while assigned sends a message to that bridge. The project home retries delivery when a bridge is offline. Run `ftown tickets inbox` on the assigned bridge, or `ftown tickets inbox --bridge <assigned-bridge>` from a paired bridge. Use `--json` for automation and pass the returned `nextCursor` to `--after` to read the next page.

### Work a project ticket from a session

Use `ftown projects list --json` to discover project IDs, names and home bridges. Select a project by name or ID. Use the ID when names overlap. To create a project on a particular bridge, use `ftown projects create "App" --bridge <home-bridge>`. Existing projects support `ftown projects rename <project> <name>` and `ftown projects delete <project>`.

```bash
ftown tickets list --project App --json
ftown tickets create --project App --title "Verify the release" --body "Run the smoke suite." --assignee user
ftown tickets create --project App --parent <ticket-id> --title "Test the Linux build"
ftown tickets update <ticket-id> --project App --assignee <bridge-id> --stage "In progress" --link "$FTOWN_SESSION_ID"
ftown tickets comment <ticket-id> --project App --text "Linux smoke tests passed."
ftown tickets comments <ticket-id> --project App --json
ftown tickets update <ticket-id> --project App --stage Review
```

Use `tickets show <ticket-id>` for details, `update --unlink <session-id>` to remove a worker, `update --assignee none` to clear ownership, and `tickets delete <ticket-id>` to delete a ticket. Supply `--project` on each command. Use `ftown board` for session-tree coordination and `ftown tickets` for project work.

### Manage a project board

Use `ftown boards columns list --project App --json` to discover column names, stable IDs and order. Ticket stage changes accept a display name or stable ID. Use `id:<id>` to select by ID when a display name overlaps another column’s ID. Renaming a column preserves the tickets in it.

```bash
ftown boards columns add Verification --project App
ftown boards columns rename Verification QA --project App
ftown boards columns reorder Backlog "In progress" Blocked Review QA Done --project App
ftown boards columns remove QA --move-to Review --project App
```

To remove a single ticket, run `ftown tickets delete <ticket-id> --project App`. Its subtasks become top-level tickets. To remove the entire board and its tickets, run `ftown boards delete --project App`. The project and its sessions remain available. Use `ftown boards create --project App` to start a fresh board on the same project. Use `--bridge` to select the home bridge explicitly.



### Discuss project work across bridges

Open **Discussion** on a project's board, or use `ftown discuss` from a session. Each project starts with `#general`. Channels and threads live in the project database on its home bridge. Use `--project <name|id>` and optionally `--bridge <home>` or `--json`, as for ticket commands.

```bash
ftown discuss channels list --project App
ftown discuss channels create releases --project App
ftown discuss post releases --title "Verify ARM build" --text "Linux passed. Can you test ARM?" --mention <bridge-id>/<session-id> --project App
ftown discuss threads releases --project App --json
ftown discuss read <thread-id> --project App
ftown discuss follow <thread-id> --project App
ftown discuss reply <thread-id> --text "ARM smoke tests passed." --project App
ftown discuss activity releases --after 0 --project App --json
```

A post or reply can mention sessions with repeatable `--mention <bridge-id>/<session-id>` or inline `@<bridge-id>/<session-id>`. Mentions notify the named sessions. Run `follow` from a session to receive notifications about replies and `unfollow` to stop. A session posting from another bridge uses its own identity and the project's home for storage. Read notifications with `ftown harness mail read`. For a discussion notification, use the included `ftown discuss reply` command to post in the original thread. In Pi and OMP, use the `ftown_discuss` tool with operation `reply`, the project, thread ID, and reply text. Supply the home bridge when the notification specifies one. Use `ftown_mail` for direct session messages.

Read additional result pages with `--after <nextAfter>`. For incremental channel activity, save the last post's `seq` and pass it to `activity --after` next time. `post`, `reply`, `channels create` and `create-ticket` accept a client-generated UUID via `--id` for retries.

Use `ftown discuss link <thread-id> <ticket-id>` to connect existing work, `ftown discuss create-ticket <thread-id> --title "Verify ARM release"` to create and link a ticket, or `ftown discuss for-ticket <ticket-id>` to find the source discussions. Rename with `ftown discuss channels rename <channel> <name>`. Archive with `ftown discuss channels archive <channel>` to close posting while retaining history and links. Add `--project <project>` to each command.

The sidebar groups sessions by project, then root session, then children across bridges. Supply `--project <name>` for a new root. A child inherits its root’s project. Use `--parent` for a local child or `--bridge <target> --parent` for a remote child. When the caller is already a child, the new session joins the same root, even on a third bridge. Use an absolute `--workdir` on the destination. Account choices on a remote child come from its destination bridge. Security commands and `harness mail` operate on the local bridge. Cross-bridge control requires paired account bridges.

For a worker that needs a folder from another machine, see **Copy a folder and launch a worker** in `references/sessions.md`. The recipient runs `ftown transfer receive`, the sender runs `ftown transfer send`, and the worker can start once the transfer reports `installed`. When the folder already exists on the destination, go straight to session creation. Use `ftown sessions list --remembered` to inspect last-known peer sessions from the local bridge.

Read `references/sessions.md` for the session, mail and terminal command
reference. Read `references/orchestrator.md` for practical worker coordination
examples. Read `references/quota.md` before choosing a CLI, model and effort for delegated
work (`ftown quota --json`). Each command group also has `--help`.

`ftown sessions preview <path...>` registers up to 12 files in the current
session's working directory for the dashboard, in this order. Kind is by
extension: `.html`/`.htm` → HTML, `.md`/`.markdown` → Markdown, anything else
is rejected. Each file is at most 1 MiB. A duplicate basename is rejected.
`--add <path...>` appends to the current set, `--remove <name...>` removes by
basename, and `--clear` removes the whole registration (never deletes files).
HTML previews are self-contained: inline CSS and scripts and data images work;
sibling assets and network access are unsupported. Markdown is rendered as a
readable document with GFM (tables, task lists, fenced code) in the same
sandbox iframe, with no network and only `data:` images; raw HTML inside the
markdown is isolated the same way. With two or more registered files, the
dashboard shows a selector in the preview toolbar; a relative link between
registered files switches the selector. Publish updates by writing a temporary
file and atomically renaming it into place. Use `--session-id <id>` for an
explicit target.

Messages from the preview conversation arrive as ftown mail. Respond explicitly
with `ftown sessions preview-reply --message "Your response"`; use
`--message-file <path>` or `--message-file -` for multiline replies. Reuse the
returned `--id` with the same text when retrying an uncertain outcome.

## Identity and reporting

Your id is `$FTOWN_SESSION_ID`; children also receive `$FTOWN_PARENT_SESSION_ID`.
A child's initial briefing identifies it and its parent and explains reporting:

```bash
ftown harness mail send --parent --type result "Done; checks passed"
ftown harness mail send --parent --type escalation "Blocked: need the API contract"
```

Mail arrives as `[ftown mail]` context through harness hooks/extensions where
available. Mail is for directed instructions (`--type task`), results
(`--type result`) and escalations (`--type escalation`). Use `--type fyi` for
non-urgent notes; `fyi` never wakes the recipient. Progress and status go on
your card (below), never as mail. Each new batch of mail nudges the recipient
at most once; un-read mail stays in the inbox — read it with
`ftown harness mail read`. Keep project conversations in their channel with `ftown discuss post`
and `ftown discuss reply`. Inspect peers with `ftown board`
and `ftown sessions list`.

## Status and board

Keep your card current with `ftown status set` at meaningful transitions —
starting, becoming blocked, finishing — not every turn. Set state
(`working`, `blocked`, `waiting_review`, `done`, `failed`), a short headline,
progress and any blocker. Writing a card wakes nobody. Parents read
`ftown board` (one line per child) instead of screening quiet workers, and
wait with `ftown board --wait --until any-done|any-blocked|any-ready` or
`ftown events --wait`. Idle workers show on the board and as an `idle` event.

```bash
ftown status set --state working --headline "Implementing the card store" --progress 1/4
ftown status set --state blocked --headline "Need the API contract" --on parent --text "Waiting on the contract decision"
ftown status set --state done --headline "Card store shipped; checks green"
ftown board
ftown board --wait --until any-done --timeout 300
ftown events --wait
```

Plain `ftown board` appends a `planned` section with up to 5 ready plan
items (`→ <id> <title>`, then `+N more`). `ftown board --all` also shows
retired (archived) children after the live ones, suffixed `(retired)`.
Tree events include the `plan` kind for plan changes and `removed` when a
child is removed or archived while not already exited.

## Blocked children

A usage limit, rate limit, expired login, crash, or an agent exit/error with no
result report is a failure even when the session status stays `running`.
An interactive shell that reaches `completed` — stopped, or its command
finished — is not a failure. A shell that errors still is. The blocked
child is expanded in the sidebar once per transition so its card is visible.
The bridge records a block (`usage_limit`, `rate_limit`, `auth`, `crashed`,
or `exited`, plus `resetAt` when the screen names a time) and sends the
parent one waking escalation per transition. The mail names the reason,
reset time, last screen lines, worktree, linked PR, and plan item. The
board row and the dashboard Overview show a blocked badge with that reason
and reset time. That badge is the bridge's detection. It is separate from
a card you set to `blocked` with `ftown status set`. A session with no
parent raises a human attention item titled `Session blocked` instead of
mail. The same transition is not mailed twice. `ftown sessions create` waits a few
seconds for the child to stay running. If it errors, exits, or becomes
blocked during that wait, the command exits non-zero and prints the reason.
A failure after create returns still mails the launching session.

Hand the work to a fresh session in the same directory:

```bash
ftown sessions handoff <session-id> [--shell <harness>] [--model <model>] [--name <name>]
```

Handoff commits uncommitted changes in a dedicated or bridge-created
worktree as `wip: handoff from <id>`, starts the new session there with a
brief (original prompt, recent screen, git log and diff stat, PR, plan
item), moves the plan item and PR link onto it, archives the old session,
and prints the new id. Omit `--shell` and `--model` to take the next
routing pick that still has quota. `--plain` prints only the new id.

## Plan list

Keep the plan on the manager: `ftown plan` defaults to your own session
(`$FTOWN_SESSION_ID`, the manager), and `--session-id <id>` targets another
session's plan. This is the manager's plan, not a ticket system — it is a
short ordered todo list the manager keeps for its own coordination. Add
items, order them with precedence, and link each child to one item:

```bash
ftown plan [--json] [--session-id <id>]
ftown plan add <title...> [--note <t>] [--after <id,id>] [--priority 1|2|3]
ftown plan start <id> --session <child-id>
ftown plan done <id>
ftown plan drop <id>
ftown plan todo <id>
ftown plan edit <id> [--title <t>] [--note <t>|--no-note] [--after <ids>|--no-after] [--priority n]
ftown plan rm <id>
ftown sessions create --parent --plan-item <id> --prompt "<task>"
```

Precedence comes from `--after <id,id>` and `--priority 1|2|3` (1 is
highest). An item is ready when it is `todo` and every item in its `after`
list is `done` or `dropped`; the list shows `→` ready, `·` waiting, `▸`
started, `✓` done and `✗` dropped. Creating a child with `--plan-item <id>`
requires a parent, fails before creating anything when the item is unknown
or not `todo`, and otherwise marks the item `started` with that child
linked. When the linked child's card becomes `done`, its item becomes
`done` too; a `failed` card leaves the item `started` for the manager to
decide. `ftown plan start <id> --session <child-id>` links an existing
child by hand, and `done`/`drop`/`todo` set the state directly. Every plan
change emits one `plan` tree event (`<id> <state>: <title>`, plus
` → ready: …` when items become ready). Exit codes: 0 ok, 1 error, 2 usage.

**Delegating work.** Delegate implementation to ftown child sessions (`ftown sessions create --parent ...`) rather than in-process subagents — only sessions appear on the board and dashboard (cards, events, digests, parent-first questions). For children that open PRs, pass `--require-green-pr` so the child cannot set its card to `done` until its linked PR is green/merged (parent can bypass with `ftown status set --force`). The gate is advisory against a hostile child: any local process can present the parent's id (same trust model as the local CLI); it stops honest mistakes, not malicious agents.
A child session may use its own subagents for reviews and lookups. Pick the CLI and model with `ftown quota --json` (see `references/quota.md`).

## Manager brief

If you coordinate children, set a brief at the start and add a note at each
milestone. The dashboard overview renders the brief and your children
automatically; you do not build a status page yourself.

```bash
ftown brief set --file brief.md
ftown brief note "All workers spawned; waiting on the first results"
ftown brief show
```

## Human attention and pull requests

Use `ftown sessions attention --message "..."` when you need human input. It
creates a durable attention record and uses the dashboard's existing notice flow;
a plain request does not answer a prompt or guarantee a push notification. Push
remains opt-in and requires a supported hosted session. Repeating an unresolved
request updates its occurrence count; after an uncertain result, inspect the
existing request before retrying.

If you have a parent, your request goes to your parent first, not the human:
the parent receives one waking escalation mail with the question and the
commands to answer or escalate it, and the human sees it greyed as "with
parent" (and may still answer). The parent answers with
`ftown attention answer <child-id> <event-id> --option <n>` (or
`--text "<reply>"`) only from facts it holds — the plan, the agreed contract,
earlier human answers — and escalates preferences and irreversible choices
with `ftown attention escalate <child-id> <event-id> --note "<context>"`.
Only the parent raises a parent-routed question to the human. Use
`ftown sessions attention ... --to human` for things only the human can
provide, such as credentials or approvals.

### Questions with answers

Add `--option <label>` (repeatable) to ask a question the human answers in the
dashboard inbox. `--multi` allows several choices; `--no-text` disallows a
free-text reply. Without options the question is free text. Add `--wait` to
block until the answer arrives (`--timeout <s>`, default 600). A timeout does
not cancel the question; check later with
`ftown sessions attention-status <event-id> --wait`. The command prints the
event ID.

Delivery: a live waiter receives the answer; otherwise it arrives as ftown mail
from "You" starting with `[ftown attention answer id=...]`. When the parent
answers, the same delivery applies but the mail sender is the parent session.

Claude Code `AskUserQuestion` calls inside an FTown session are answered from
the same inbox, and the terminal picker appears only after "Answer in terminal"
or an hour. Exit codes and waiting details: `references/sessions.md`.

Attach one GitHub pull request with `ftown sessions pr <URL>`; another URL
replaces it and `--clear` removes it. This records a link without creating a PR.
While the bridge runs, linked agent sessions receive durable inbox mail when GitHub's observed current-head rollup
checks fail or pass, or the PR merges. Link association enables this automatically;
clearing the link stops future observations. The bridge uses local `gh` authentication
and polling (typically one minute for pending and five minutes for completed checks),
so rate limits, authentication, offline periods and changes between polls can delay or
miss transitions. Durable enqueue does not guarantee an agent reads or processes mail.
Mail for already-stopped agents stays queued without starting them;
an already-admitted delivery can finish as a session stops. These facts do not
authorize a merge or other action. Both commands target trimmed
`$FTOWN_SESSION_ID` unless you supply `--session-id <id>`; they never guess identity from the working directory.
Older bridges report `bridge_upgrade_required` before mutation.

## Harness accounts

Register separate Claude or Codex configuration directories with
`ftown accounts add <id> --harness claude|codex --config-dir <absolute-path>`.
Adding an account sets up its harness hooks and skill link. Use `--no-setup` to
defer setup. If setup fails, the account remains saved; run `ftown setup` to retry.
Account IDs are lowercase slugs; `default` is reserved and means the harness's
normal configuration directory. Paths must be absolute and are used as-is for
the harness environment variable (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`). FTown
does not copy, link, or read credentials between account directories.

Choose an account when starting a session with `ftown sessions create
--shell claude --account personal ...` (or `--shell codex`). A child started
on its root’s bridge inherits the root’s account unless `--account` is supplied. For a remote root, choose an account registered on the child’s bridge or use its default.
To constrain future children, set `--allowed-accounts personal,work`; the
bridge enforces this policy for CLI and API requests, intersecting a child's
requested list with inherited restrictions so descendants can only narrow it.
When a parent resolves through an alias, both policies apply. Attempts to select an account outside the parent's
list fail with `account_not_allowed`. An omitted policy leaves children
unrestricted. Setup installs FTown hooks, skill links, and supported plugins
for the default configuration and each registered account configuration. For
Codex accounts, setup links the skill into `CODEX_HOME/skills`, a Codex
compatibility skill root.

To ask with options or free text, use `ftown sessions attention --option ...` or
`--questions-json`, then check the returned event ID with `ftown sessions
attention-status <event-id>` until it is resolved. `event.answer` holds the
answer; a resolution without an answer means it was dismissed. The inbox,
acknowledge and resolve operations never answer the agent's question.

For tasks performed in an FTown session, associate the task's GitHub PR when
created or updated, before the completion notice: use `ftown sessions pr <URL>`.
Omit this step for tasks without a PR; never invent a PR or guess a session
identity.

Once the task is complete, a top-level session requests user attention **once
per completed task**, before the final handoff, using
`ftown sessions attention --title 'Work complete'
--message "<truthful outcome, checks and PR summary>"`.
Do not send a completion notice every turn; retain the uncertain-result guidance
above. If you have a parent, do not raise "Work complete": set your card to
`done` and report your result to the parent as assigned; the parent raises one
completion notice for the whole job. See the completion example in
`references/sessions.md`.

## Cleanup

Session cleanup is an explicit user or orchestrator action. Reporting a result
does not remove a child automatically. Keep sessions available for follow-up
until cleanup is requested or the coordinating task calls for it.

```bash
ftown sessions remove <finished-session-id>
ftown sessions archive
ftown sessions revive <archived-session-id>
```

Removal archives the session; revival creates a new session id and resumes its
agent conversation when supported. Preserve useful results before cleanup.

For children that write code, create them with their own worktree:
`ftown sessions create --parent --worktree [--branch <b>] [--base <ref>]`.
`ftown sessions remove <id>` retires a bridge-created worktree when it is
clean and merged or pushed; otherwise it keeps the worktree and says why.
`--keep-worktree` always keeps it, `--force-worktree` forces removal.
Inspect or clean up archived worktrees with `ftown worktrees list` and
`ftown worktrees prune`.

## Connection and compatibility

The commands read `~/.ftown/bridge.json`. Anyone who can read that file can
control the bridge's sessions. Existing `ftown-sessions`, `ftown-harness`, and
`ftown-env` launchers remain compatible; use the grouped commands above in new
instructions. ftown does not install a ticket system or provide a workflow
runner. Independently installed coordination tools remain yours to manage.
