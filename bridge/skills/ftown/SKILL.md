---
name: ftown
description: >-
  Control ftown sessions and multi-provider routing: create/list/read/drive
  sibling sessions (screen, keys, grep), archive/revive/remove them, send and
  read ftown mail, request human attention or ask questions with options,
  register HTML/Markdown previews and read preview replies, link session PRs,
  coordinate worker agents, and read subscription quota/usage plus
  model-routing tiers across claude, codex, grok, muse, agy and opencode
  (`ftown quota --json`). Use for ftown sessions, child/sibling agents, bridge
  mail/inbox, previews, choosing which CLI/model/effort should run delegated
  work, checking remaining plan usage, local bridge diagnostics, or
  orchestration.
---

# ftown

Use `ftown start`, `ftown sessions`, `ftown harness`, and `ftown env`. Run `ftown --help`
for command discovery; if it is missing from PATH, use `~/.ftown/ftown`.
The bridge installs this skill at `~/.ftown/skills/ftown`, linked from the agent
skill directories. Startup checks setup readiness and never rewrites global
integrations. Before the installed command exists, run setup from the package:

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
uses its copied version independently of the npm cache and does not discover
newer packages.
Use `ftown setup --repair` to repair that current copied version or detect new
optional harnesses. If the copied runtime is incomplete, use the matching package
entrypoint with `--repair`.

## Commands and references

```bash
ftown sessions list
ftown sessions create --prompt "Review the auth module" --workdir "$PWD" --parent
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
ftown sessions create --parent --plan-item p2 --prompt "Review the API client"
ftown brief set --file brief.md
ftown attention list
ftown worktrees list
ftown harness mail send <session-id> --type task "review the API client"
ftown harness mail read
ftown env --help
ftown setup --help
ftown start --help
```

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
`ftown harness mail read`. Prefer mail for agent communication; use terminal
key injection only when the task needs it. Inspect peers with `ftown board`
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

**Delegating work.** Delegate implementation to ftown child sessions (`ftown sessions create --parent ...`) rather than in-process subagents — only sessions appear on the board and dashboard (cards, events, digests, parent-first questions).
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
