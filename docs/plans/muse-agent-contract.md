# Muse harness contract (FROZEN — implementers must not renegotiate)

Add Muse Code (`muse` 1.3.0, binary at `~/.local/bin/muse`) as a first-class
ftown harness with id `muse`. Precedents: fresh-spawn mirrors `grok`
(standalone, prompt-as-CLI-arg, unhooked); resume mirrors `kimi-code`
(workdir-based, no persisted native id).

## Why this shape (decisions)

- Root `muse` has NO `--session-id` pin flag (only `muse exec` does), and there
  is no ftown hook channel into Muse yet, so deterministic native-id resume is
  impossible in Phase 1. `muse resume --last` is workspace-scoped, giving a
  kimi-code-style workdir resume with the same accepted weakness class.
- `--yolo` ("disable approval and sandboxing and trust this workspace") is the
  ftown-equivalent unattended flag (cf. `--force`/`--always-approve`/`--auto`).
- Token usage IS in `~/.local/share/muse/sessions/YYYY/MM/DD/*/session.jsonl`
  (`model_completed` events), so a workdir-based usage extractor is in scope.

## Frozen command strings (all values shellQuoted, `'…'` + `'\''` escapes)

- Fresh: `muse --yolo --workspace '<workdir>' [--model '<model>'] ['<prompt>']`
  (`--workspace` only when workdir known; `--model` only when set; prompt only
  on the prompt-as-CLI-arg path). Flag order mirrors cursor.
- Resume: `muse --yolo --workspace '<workdir>' resume --last`
  (early-return: no model, no prompt — codex/opencode precedent).

## Frozen registry spec (`HARNESSES.muse`)

`buildCommand=buildMuseCommand, hooked=false, promptAsCliArg=true,
resumeField=none, providerBase=none, validForLoop=true,
validForWorkflow=false`, no `spawnStaggerMs`.

## Frozen data-model decisions

- NO new `Session`/`CreateSessionPayload` fields (no `museSessionId`).
- `canResumeStoredSession`: muse → always true (mirror kimi-code branch).
- `deriveRelaunchCommand` + revive/resurrection gating: mirror kimi-code.
- `session-ids.ts` persister: NO change (verify kimi-code is absent there).
- UI `hasCollectableUsage`: muse gated on `workingDir` only (mirror kimi-code).
- `shortModelName` regex: add `muse-` vendor-prefix strip.
- UI standalone pattern (NOT the `top=claude` flavor pattern).
- Label `Muse`; CSS var `--harness-muse` = the standard non-Claude value
  (verify against `--harness-grok`); glyph a11y label `Muse agent`.

## Parity invariants (mechanical check)

- Every case-insensitive `grok` hit in `bridge/src` and `ui/src` gains a muse
  counterpart in the same file, UNLESS this contract names the file untouched.
- Resume-path files mirror `kimi-code` hits, not grok.

## Explicitly untouched

`loop-validation.ts` (derived), `workflow-runner-cli.ts` (SHELLS + guard),
`factory/types.ts` (no factory-init), `Terminal.tsx`, `mail-delivery.ts`,
`provider-env-store.ts`, `session-resurrection.ts` (generic gating only),
`docs/plans/grok-agent-contract.md` (historical).

## Non-goals (follow-ups, NOT this task)

Factory-init, workflows (`muse exec --json` is the natural future fit),
Terminal TUI keys, hook `decision`-JSON deny semantics.

## Amendment A1 — hooked Muse (FROZEN, supersedes resume + hooked sections)

Empirical ground truth (echo-provider probes, transcripts under
/tmp/muse-hook-probe2): Muse hooks are a NATIVE PLUGIN bundle, not
`.muse/hooks.json` (silently ignored). Bundle =
`<dir>/.muse-plugin/plugin.json` + one executable script per event
(`command` is an argv array; duplicate sources rejected; no symlinks).
Install: `muse plugins install <dir> --scope user` + `muse plugins approve
<id>` (hooks inert until approved; updates flip to `modified`, also inert
until re-approved). Payload: JSON on stdin, `session_id` on EVERY event;
env carries no session id (only `MUSE_PLUGIN_*`). `SessionStart` does NOT
re-fire on resume — persist the id from ANY event. Hook output: only a
JSON `hookSpecificOutput` decision object acts; non-JSON/exit codes never
block. `timeoutMs` default 5000 — hooks must be fast/fire-and-forget.

Frozen v2 deltas:
- `HARNESSES.muse`: `hooked=true`, `resumeField='museSessionId'`.
- Resume string: `muse --yolo --workspace '<DIR>' resume '<ID>'`
  (early-return, no model/prompt). Fresh string UNCHANGED.
- New `museSessionId` on Session + CreateSessionPayload (bridge + UI) +
  create/relaunch/RPC threading — mirror the `opencodeSessionId` path.
- `canResumeStoredSession`: muse requires `museSessionId` (opencode branch).
- Plugin bundle (NEW, bridge-owned): `bridge/muse-plugin/` with
  `.muse-plugin/plugin.json` (id `ftown`, schemaVersion 1,
  capabilities.hooks = SessionStart + Stop ONLY, argv commands, unique
  script per event, timeoutMs 5000) + `hooks/ftown-session-start.sh` +
  `hooks/ftown-stop.sh` (+ optional shared `lib/` helper invoked with
  argv — never symlinks).
- Scripts: exit 0 immediately when `FTOWN_SESSION_ID` unset. Bridge
  reachability (URL/port source) mirrors the pi/opencode hook precedent.
  SessionStart: POST native `session_id`+cwd+ftown ids to bridge `/hook`.
  Stop: POST hook + drain inbox, mail emitted as `additionalContext` JSON.
- Installer (NEW): `bridge/src/muse-plugin-installer.ts` — probe
  `command -v muse`; install/update (`update` only on content drift, then
  re-approve); non-interactive `approve`; invoked from `index.ts` startup.
  Mirror `opencode-plugin-installer.ts` structure + tests.
- `session-ids.ts`: persist hook `session_id` → `museSessionId` when
  `shellType==='muse'` (mirror opencode case + cache), from ANY event.
- Usage: id-first (date-partition scan for `/<uuid>/session.jsonl`
  suffix, codex-style) with workdir fallback (existing U1 path).
- UI: `museSessionId` types + create/resume payload threading mirrors
  `opencodeSessionId`; `hasCollectableUsage`: `museSessionId||workingDir`;
  builder resume form + mirror test + snapshot updated.
- Docs: muse joins the HOOKED group (sessions.md, orchestrator.md).
  (Correction: loops.md has no resume cell — `--shell` list only — so no
  loops.md change is owed beyond Wave 1; `--last` appears nowhere.)
- Wave-1 nits folded in: fix stale comments in `create-ftown-session.ts`,
  `usage-collector.ts`, `agent-commands.ts` (noted in INT report §risks-3).

## Usage extractor (U1) branch

Scan `~/.local/share/muse/sessions/YYYY/MM/DD/*/session.jsonl` newest-first;
select by workspace match + `createdAt` disambiguation (mirror kimi-code/pi);
sum `model_completed` `usage{input_tokens,output_tokens,cached_tokens,
cache_write_tokens,cache_read_tokens,reasoning_tokens}`; models from the
events' `model` field; all failures → null; add dir override to
`UsageCollectorOptions`. If session.jsonl provably lacks a workspace marker,
return BLOCKED with evidence (descope to null, grok precedent).

## Gates (every task)

Repo-configured typecheck + lint for the touched area, plus the task's owned
unit tests — all green in-session. Byte-identical bridge/UI builder output.
