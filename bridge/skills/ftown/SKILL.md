---
name: ftown
description: >-
  Control ftown sessions: create/list/read/drive sibling sessions, send ftown
  mail, request human attention, link session PRs, and coordinate worker agents.
  Use for ftown sessions, child/sibling agents, bridge mail/inbox, or explicitly
  requested orchestration.
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
ftown sessions pr https://github.com/owner/repo/pull/123
ftown sessions pr --clear
ftown sessions preview ./preview.html
ftown sessions preview --clear
ftown sessions preview-reply --message "The preview is ready."
ftown harness mail send <session-id> --type task "review the API client"
ftown harness mail read
ftown env --help
ftown setup --help
ftown start --help
```

Read `references/sessions.md` for the session, mail and terminal command
reference. Read `references/orchestrator.md` for practical worker coordination
examples. Each command group also has `--help`.

`ftown sessions preview <path>` registers a self-contained HTML file in the
current session's working directory for the dashboard. Inline CSS and scripts
and data images work; sibling assets and network access are unsupported. Publish
updates by writing a temporary file and atomically renaming it into place. Use
`--session-id <id>` for an explicit target or `--clear` to remove registration;
clearing never deletes the file.

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
available. Cursor and shell sessions receive an idle nudge to read their inbox.
Prefer mail for agent communication; use terminal key injection only when the
task needs it. Inspect peers with `ftown sessions list` and
`ftown sessions screen <id> --limit 100`.

## Human attention and pull requests

Use `ftown sessions attention --message "..."` when you need human input. It
creates a durable attention record and uses the dashboard's existing notice flow;
it does not answer a prompt or guarantee a push notification. Push remains opt-in
and requires a supported hosted session. Repeating an unresolved request updates
its occurrence count; after an uncertain result, inspect the existing request
before retrying.

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

Remote MCP callers use `attention_request` with explicit `machine` and
`sessionId`, or `sessions_update` with `pullRequestUrl` (string to set, null to
clear). Mutation tools require control access; remote callers have no automatic
local self identity. Keep the returned attention event ID for existing inbox,
acknowledge and resolve operations, which do not answer the agent's question.

For tasks performed in an FTown session, associate the task's GitHub PR when
created or updated, before the completion notice: use `ftown sessions pr <URL>`
or MCP `sessions_update.pullRequestUrl`. Omit this step for tasks without a PR;
never invent a PR or guess a session identity.

Once the task is complete, request user attention **once per completed task**,
before the final handoff, using `ftown sessions attention --title 'Work complete'
--message "<truthful outcome, checks and PR summary>"` or MCP `attention_request`.
Do not send a completion notice every turn; retain the uncertain-result guidance
above. Children must still report their result to the parent as assigned; user
attention does not replace that reporting. See the completion example in
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

## Connection and compatibility

The commands read `~/.ftown/bridge.json`. Anyone who can read that file can
control the bridge's sessions. Existing `ftown-sessions`, `ftown-harness`, and
`ftown-env` launchers remain compatible; use the grouped commands above in new
instructions. ftown does not install a ticket system or provide a workflow
runner. Independently installed coordination tools remain yours to manage.
