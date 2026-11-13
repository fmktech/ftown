# Antigravity harness + hooked Grok contract (FROZEN — implementers must not renegotiate)

Two changes on one branch, because they thread the same files:

1. Add Google Antigravity CLI (`agy` 1.5.8, `~/.local/bin/agy`) as a first-class
   harness with id `antigravity`, label `Antigravity`.
2. Give the existing `grok` harness a captured native session id and id-based
   resume, fed by Grok hooks. This supersedes the "no resume, no
   `grokSessionId`" non-goal in `docs/plans/grok-agent-contract.md`
   (historical; leave that file untouched).

Precedent for both: the hooked Muse work (`docs/plans/muse-agent-contract.md`,
Amendment A1). Wherever this contract says "mirror muse", copy the
`museSessionId` treatment in the same file.

## Frozen command strings (all values via `shellQuote`)

- Antigravity fresh: `agy --dangerously-skip-permissions [--model '<model>'] [-i '<prompt>']`
  (`--model` only when set; `-i` only on the prompt-as-CLI-arg path). No
  workdir flag: agy inherits the runner cwd.
- Antigravity resume: `agy --dangerously-skip-permissions --conversation '<ID>'`
  (early return: no model, no prompt). `-c/--continue` is NOT used: its scope
  is undocumented.
- Grok fresh: UNCHANGED — `grok --always-approve [-m '<model>'] ['<prompt>']`.
- Grok resume: `grok --always-approve -r '<ID>'` (early return: no model, no
  prompt).

## Frozen builder signatures (`bridge/src/harness-registry.ts`)

```ts
export function buildAntigravityCommand(options: {
  model?: string;
  antigravitySessionId?: string;
  initialPrompt?: string;
}): string;

export function buildGrokCommand(options: {
  model?: string;
  grokSessionId?: string;
  initialPrompt?: string;
}): string;
```

`BuildCommandInput` gains `grokSessionId?: string` and
`antigravitySessionId?: string`. `HarnessSpec.resumeField` gains
`'grokSessionId' | 'antigravitySessionId'`. `harnessAcceptsPromptAsCliArg`'s
`Pick` gains both.

## Frozen registry specs

- `HARNESSES.antigravity` (inserted directly after `muse`):
  `buildCommand=buildAntigravityCommand, hooked=true, promptAsCliArg=true,
  resumeField='antigravitySessionId'`, no `providerBase`, no `spawnStaggerMs`.
- `HARNESSES.grok`: `hooked=false` UNCHANGED (Grok has no turn-end injection,
  so mail stays a typed nudge), `promptAsCliArg=true`,
  `resumeField='grokSessionId'`.

## Frozen data model

- New optional string fields `grokSessionId` and `antigravitySessionId` on
  `Session` and on the create-session payload, bridge and UI, threaded through
  create / relaunch / RPC / tombstone-revive exactly as `museSessionId` is.
- `canResumeStoredSession`: `grok` requires `grokSessionId`; `antigravity`
  requires `antigravitySessionId` (muse branch shape).
- `session-ids.ts`: hook `session_id` lands in `grokSessionId` when
  `shellType==='grok'` and in `antigravitySessionId` when
  `shellType==='antigravity'`, from ANY event, with cache entries; neither may
  fall through to `claudeSessionId`.
- Native mail wake: both harnesses are `unsupported` (muse precedent).
- Usage: neither harness has a usage source; `collectSessionUsage` returns
  null and UI `hasCollectableUsage` returns false for both. No extractor.
- UI: `antigravity` is a standalone shell option (NOT a claude flavor) with a
  free-text model input mirroring muse. Label `Antigravity`; a11y label
  `Antigravity agent`; CSS var `--harness-antigravity` with the same value as
  `--harness-muse`; an original simple inline-SVG glyph (no third-party brand
  asset).

## Hook wire format (bridge side is UNCHANGED)

The bridge `/hook` route only understands snake_case bodies. Translation from
each agent's native payload happens in that agent's hook script, never in the
bridge. Scripts POST exactly:

```json
{ "ftown_session_id": "...", "ftown_session_source": "env",
  "hook_event_name": "...", "session_id": "<native id>", "cwd": "...",
  "tool_name": "...", "tool_input": {} }
```

(`tool_*` only on tool events.) Scripts are inert (exit 0, no output) when
`FTOWN_SESSION_ID` is unset, and always exit 0.

The hook scripts, their installers and the setup wiring are specified in a
later amendment, after the hook behaviour of both CLIs has been confirmed.

## Amendment A1 — Grok hooks (FROZEN; empirical, grok 1.0.77)

Ground truth from live probes (headless and TUI), cross-checked against the
verbatim docs at `~/.grok/docs/user-guide/10-hooks.md`:

- User-level hooks load from `~/.grok/hooks/*.json`, shape
  `{"hooks":{"<Event>":[{"hooks":[{"type":"command","command":"<abs>","args":[],"timeout":<s>}]}]}}`.
  The empty `args` array is REQUIRED: without `args` Grok runs `command`
  through `sh -c` and a path containing a space is split; with `args` present
  (even empty) Grok starts `command` directly as one program.
- Every payload carries BOTH spellings: `session_id`/`sessionId`,
  `hook_event_name` (PascalCase value, e.g. `"Stop"`)/`hookEventName`
  (snake value), `tool_name`, `tool_input`, `tool_use_id`, `cwd`. Read the
  snake_case keys.
- The hook process inherits the launching environment (`FTOWN_SESSION_ID`,
  `FTOWN_HOOK_PORT`, `FTOWN_HOOK_TOKEN` are visible). The native id is a UUID,
  stable for the run, and unchanged by `grok -r <id>` (SessionStart re-fires
  with `source:"load"`).
- A Stop hook that prints `{"decision":"block","reason":"<text>"}` and exits 0
  makes the agent continue with `<text>`. UserPromptSubmit/SessionStart stdout
  is NOT injected.
- Every process exit fires an extra `Stop` with `reason:"shutdown"`; a real
  turn end has `reason:"end_turn"`.
- In the TUI, hooks do not run until the folder is trusted (grok's own
  "Do you trust…" prompt). ftown does NOT bypass folder trust: the owner
  answers that prompt once per folder, as today.

Frozen design:

- Registry: `HARNESSES.grok.hooked` stays `false`. The Stop pump delivers mail
  that arrives mid-turn; the existing 5s typed nudge still covers an idle
  agent. No change to `mail-delivery.ts`.
- Script (NEW, bridge-owned): `bridge/hooks/ftown-grok-hook.sh`, installed to
  `~/.ftown/grok-hook.sh`. Reads the payload on stdin; exits 0 with no output
  when `FTOWN_SESSION_ID` is unset or `curl`/`jq` is missing; always exits 0.
  Bridge reachability, auth, inbox read and mail text format mirror
  `bridge/muse-plugin/lib/ftown-hook.sh` exactly.
  - POSTs the wire format above for every event EXCEPT `Stop` with
    `reason` `"shutdown"` or `"channel_closed"` (Grok's two session-end
    reasons; not posted at all).
  - Grok clips a Stop block `reason` at 10,000 characters, after the inbox
    drain has already marked the mail delivered. The script therefore caps the
    emitted mail text at 9,500 characters and, when it had to cut, ends it
    with a one-line pointer telling the agent how to re-read its delivered
    mail.
  - On `Stop` with `reason == "end_turn"` only: drains the inbox and, when
    mail count > 0, prints `{"decision":"block","reason":"<mail text>"}`.
    Nothing is printed for any other event or reason.
- Events registered: `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `Stop`, `SessionEnd`; `timeout` 10 on each.
- Installer (NEW): `bridge/src/grok-hook-installer.ts`

  ```ts
  export function installGrokHooks(bundledScriptPath: string, home?: string): boolean;
  ```

  Returns false and writes nothing when `<home>/.grok` does not exist. Otherwise
  copies the script to `<home>/.ftown/grok-hook.sh` (mode 0755) and writes
  `<home>/.grok/hooks/ftown.json` (ftown owns this whole file; other files in
  that directory are never touched). Idempotent; atomic write (tmp + rename).

Non-goals added: Grok usage extraction from `usage.json`, `Notification`
(`idle_prompt`) attention items, bypassing folder trust.

## Amendment A2 — Antigravity hooks (FROZEN; empirical, agy 1.5.8)

Ground truth from live probes (headless and TUI):

- The global file `~/.gemini/config/hooks.json` loads for every workspace with
  no approval step. Top level is hook-name → events. `SessionStart`,
  `PreInvocation`, `Stop` take a flat handler list
  `[{"type":"command","command":"<cmd>","timeout":<s>}]`; `PreToolUse` and
  `PostToolUse` take `[{"matcher":"*","hooks":[<handler>]}]`. A workspace
  `.agents/hooks.json` runs in addition to the global file.
- Payload keys are camelCase only: `conversationId`, `hookEventName`, `cwd`
  (the agent's working directory) on every event; tool events carry
  `toolCall{id,name,args}`; `PreInvocation` carries `invocationNum`.
- The hook process inherits the launching environment. Its own working
  directory is the folder holding hooks.json, not the workspace.
- `SessionStart` fires on the first message, and does NOT fire again on
  `--conversation <id>` resume: the id must be reported on every event.
- `PreInvocation` fires several times per turn (`invocationNum` 0, 1, …).
- A Stop hook printing `{"decision":"continue","reason":"<text>"}` makes the
  agent continue with `<text>`. `continuationActive` is NOT reliable (stays
  false) and must not be used.
- ANY non-zero exit from a `PreToolUse` hook BLOCKS the tool. The script must
  never exit non-zero.
- No hook fires when the user denies a tool or quits; a session can therefore
  stay marked busy until the next event. Accepted limitation.
- In the TUI a new folder shows agy's own trust prompt first; ftown does not
  bypass it.

Frozen design:

- Script (NEW, bridge-owned): `bridge/hooks/ftown-antigravity-hook.sh`,
  installed to `~/.ftown/antigravity-hook.sh`. Reads the payload on stdin;
  exits 0 with no output when `FTOWN_SESSION_ID` is unset or `curl`/`jq` is
  missing; ALWAYS exits 0. Bridge reachability, auth, inbox read and mail text
  format mirror `bridge/muse-plugin/lib/ftown-hook.sh` exactly.
  - Translation to the wire format: `session_id` ← `conversationId` (fallback
    `$ANTIGRAVITY_CONVERSATION_ID`); `cwd` ← `cwd`; `tool_name` ←
    `toolCall.name`; `tool_input` ← `toolCall.args`; `tool_use_id` ←
    `toolCall.id`.
  - Event names: `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop` are sent
    unchanged. `PreInvocation` with `invocationNum == 0` is sent as
    `UserPromptSubmit` (the bridge's "new turn started" signal);
    `PreInvocation` with any other `invocationNum` is not posted. Any other
    event name is not posted.
  - On `Stop` only: drains the inbox and, when mail count > 0, prints
    `{"decision":"continue","reason":"<mail text>"}` (ordering relative to the
    POST is fixed by Amendment A2.1). Nothing is printed in any other case.
  - Observed live: on the first run in a folder agy has not yet trusted, it
    sends `cwd: ""`. The bridge does not read `cwd`, so this is harmless.
- Hook entry: top-level key `ftown`, events `SessionStart`, `PreInvocation`,
  `PreToolUse`, `PostToolUse`, `Stop`, `timeout` 10 on each handler, `matcher`
  `"*"` on the two tool events.
- Hook command string (agy runs it with `sh -c`):
  `<shell-quoted script path> 2>/dev/null || true`. The `|| true` guard is
  REQUIRED: the `ftown` entry outlives the script (ftown uninstalled, `~/.ftown`
  deleted, exec bit lost), and without it a missing script exits 127 from
  every `PreToolUse` hook, which blocks every tool in every agy session on the
  machine. With the guard a missing or failing script is a silent no-op, and
  stdout (the Stop `decision` line) still passes through.
- The installer follows a symlinked `hooks.json` to its target instead of
  replacing the link, and refuses (returns false) to rewrite a file the user
  has made read-only. A rewrite reformats the file to 2-space JSON.
- Installer (NEW): `bridge/src/antigravity-hook-installer.ts`

  ```ts
  export function installAntigravityHooks(bundledScriptPath: string, home?: string): boolean;
  ```

  Returns false and writes nothing when `<home>/.gemini` does not exist.
  Otherwise copies the script to `<home>/.ftown/antigravity-hook.sh` (mode
  0755) and sets ONLY the top-level `ftown` key in
  `<home>/.gemini/config/hooks.json`, preserving every other key. An existing
  file that is not a JSON object is left untouched (return false). Idempotent;
  atomic write (tmp + rename).

## Amendment A2.1 — turn-end ordering (FROZEN; applies to BOTH scripts)

The bridge marks a session idle when it receives `Stop`. When a Stop hook
hands the agent mail, the agent keeps working and neither CLI emits a new
"turn started" event, so posting `Stop` first would show a working agent as
idle (idle attention fires, new mail gets typed mid-turn). Therefore, on a
turn-end Stop:

1. drain the inbox FIRST;
2. if mail was delivered: print the decision line and do NOT post `Stop`
   (post nothing; the session stays in its current busy state);
3. if no mail was delivered: post `Stop`, print nothing.

Antigravity only: the inbox is drained only when the Stop payload's
`terminationReason` is not one of `MAX_FORCED_INVOCATIONS`, `USER_CANCELED`,
`ERROR` (on those agy will not continue, so drained mail would be lost); for
those three reasons the script posts `Stop` and prints nothing. `tool_input`
is sent only when `toolCall.args` is a JSON object. The script also exits 0
when it receives HUP, INT, TERM or PIPE.

## Amendment A3 — setup wiring (FROZEN)

`bridge/src/setup.ts` `installIntegrations` calls `installGrokHooks` and
`installAntigravityHooks` with the bundled script paths under `bridge/hooks/`
(already in package `files`), alongside the existing installers, each
failure-isolated the same way its neighbours are.

## Amendment A4 — Grok's Claude-hook compatibility (FROZEN; found live)

Grok loads the hooks in `~/.claude/settings.json` by default. ftown's Claude
hooks therefore ALSO run inside every Grok session: `~/.ftown/notify.sh`
posts a second copy of each event (including the exit-time `Stop`, and a
`Stop` right after mail was handed over, which marks a working session idle),
and `ftown-harness hook-pump` drains the same inbox in competition with the
Grok script, on events where Grok discards hook output.

ftown does NOT change Grok's global `[compat.claude] hooks` setting (the owner
may rely on Claude hooks in their own Grok sessions). Instead ftown's Claude
hook entry points stand down when they are running under Grok, detected by
the `GROK_HOOK_EVENT` environment variable that Grok sets on every hook
process:

- `bridge/hooks/notify.sh`: consumes stdin, then exits 0 with no output and no
  network call when `GROK_HOOK_EVENT` is non-empty.
- `ftown-harness hook-pump` and `ftown-harness ask-hook`: exit 0 with no
  output, no inbox read and no network call when `GROK_HOOK_EVENT` is
  non-empty.

`bridge/hooks/ftown-grok-hook.sh` is then the only ftown channel in a Grok
session. Behaviour under Claude, Codex and Cursor is unchanged.

Refinements (FROZEN):

- "Running under Grok" requires BOTH signals: `GROK_HOOK_EVENT` non-empty AND
  a string `hookEventName` key in the stdin payload (Grok always sends it;
  Claude, Codex and Cursor payloads do not). The variable alone is not enough:
  a Claude or Codex session started from inside a Grok hook process inherits
  it and must keep its ftown hooks.
- `notify.sh` still forwards Grok's `Notification` event
  (`GROK_HOOK_EVENT=notification`): the Grok script does not register it, and
  it is what raises the dashboard attention item for a Grok permission prompt
  today.

## Explicitly untouched

`docs/plans/grok-agent-contract.md`, `docs/plans/muse-agent-contract.md`,
`bridge/muse-plugin/**`, `usage-collector.ts`,
`preview-chat-protocol.ts`, `provider-env-store.ts`, the `/hook` route parser.

## Non-goals

Antigravity usage/quota, Antigravity plugin packaging, model pickers with
fixed lists, effort flags, Grok `Notification` attention items, tiers.

## Gates (every task)

Run from the worktree `/Users/fkesheh/projects/ftown-antigravity`:

- bridge typecheck: `cd bridge && npx tsc --noEmit`
- bridge tests: `cd bridge && node --import tsx --test <owned test files>`
- ui typecheck: `cd ui && npx tsc --noEmit`
- ui tests: `cd ui && npx vitest run <owned test files>`

Never run `npm run build` or `next build`. `next lint` has no config on this
branch and is not a gate.
