# Session attention request and PR association

Status: independently reviewed and FROZEN for implementation. Shared checkout `/Users/fkesheh/projects/ftown-simplify-all`; branch `feat/session-attention-pr`; base `9e636a55ff122884daefa54e90cb9d6f168712b7`. This document is both the external API style/spec and the frozen implementation contract. User requested an agent-callable attention tool and PR association with its ftown session. An optional question about multiple PRs remains unanswered; default is one replaceable PR per session.

## Existing API style

CLI commands are kebab-case verbs under `ftown sessions`, with Commander options, JSON output by default and local pointer/bearer authentication. `FTOWN_SESSION_ID` is the canonical local self identity; remote MCP deliberately cannot infer self. MCP tool names are snake_case, arguments camelCase, and targets always carry both `machine` and `sessionId`. HTTP resources use plural `/api/sessions/{id}`, with opaque IDs matching `[A-Za-z0-9_-]+`, no path version, resource envelopes (`{session}`, `{events}`), 200 for mutations/reads and 201 for new sessions.

Local HTTP errors are the existing `{error:string,code?:string}` envelope. AttentionError already supplies stable codes; controller metadata errors retain their established mapping. MCP uses its existing `{error:{code,message,outcomeUnknown,status?}}` and `isError:true`. Keep these transport-specific conventions: do not invent a new global error/correlation framework for this additive change (explicit architect-approved deviation from a single cross-transport envelope). HTTP host/origin guards plus bridge bearer authentication authorize access to sessions belonging to that bridge; local self ID is a selector, not a narrower security credential. MCP additionally restricts machines to the verified OAuth grant, requires `mcp:control` for mutations, and revalidates authorization. Do not bypass either layer.

Existing attention inbox collections use bounded cursors (50 default/100 maximum); this task adds no collection endpoint. Metadata updates and explicit attention use the existing local/mcp_request transport limits, body limits, timeout and access revalidation. No new independent rate-limit bucket, network fetch, OAuth scope, transport, database or dependency.

## Resource and typed surface

One Session may have one optional `pullRequestUrl?: string`. It belongs to the bridge owning that Session. One Session already has a durable ledger of AttentionItem records and a separate live hook event stream consumed by the dashboard. These must remain connected.

```ts
interface RequestSessionAttention { title?: string; message: string }
interface RequestSessionAttentionResult { event: AttentionItem }
interface SessionPullRequestUpdate { pullRequestUrl?: string | null }
// Existing AttentionItem fields/type remain unchanged; existing records remain readable.
// GET session capabilities gain additive flags without changing attention version 1:
interface AddedCapabilities {
  attention?: { version: 1; request: true };
  sessionMetadata: { pullRequest: true };
}
```

| Operation | Input / output | Auth and object scope | Errors / retry behavior |
|---|---|---|---|
| `POST /api/sessions/:id/attention` | Strict RequestSessionAttention → 200 `{event:AttentionItem}` | Existing bridge bearer, host/origin checks; target must exist on this bridge and be running/pending | 400 invalid fields/text, 404 unknown_session, 409 session_not_active, 503 attention_not_ready, existing sanitized 500 attention_storage_error. Logical duplicates coalesce into the existing unresolved fingerprint record; occurrences/lastSeenAt still record attempts. Push/wait notification occurs only on creation. A request after resolution is a new incident. No claim of strict state idempotence. |
| Existing `PATCH /api/sessions/:id` | Add pullRequestUrl:string|null; existing name/parent inputs retained → 200 `{session}` | Existing bridge bearer and target existence; metadata allowed for any retained session status | Existing 400/404/503/error envelope. Validate every provided field before any mutation; same URL/clear is naturally idempotent in resource state. Omitted field preserves; null removes. |
| MCP `attention_request` | `{machine,sessionId,title?,message}` → `{machine,sessionId,event}` | Mutating tool, authorized machine and mcp:control; access checked before/after mutation as siblings | Existing MCP error wrapper; probe attention.request===true, otherwise bridge_upgrade_required; non-idempotent annotation because occurrence timestamps change. Never automatically retry uncertain mutation. |
| MCP `sessions_update` | Add pullRequestUrl:string|null to existing strict schema | Existing mutation access; probe sessionMetadata.pullRequest when new field supplied | bridge_upgrade_required on old bridge BEFORE PATCH, including mixed name+PR mutations; legacy name/parent paths unchanged. |

Attention input: trim nonempty title (optional, maximum 200 chars) and message (required, maximum 2000 chars); reject unknown keys and wrong types before persistence. Default title `Session needs your input`. Reuse `sanitizeAttentionText` for controls/common credential redaction; reject a message/title that becomes empty. Use a Notification with notification_type `agent_needs_input`. `AttentionStore.record` may add an internal `AttentionItem | undefined` return, captured in the SAME serialized transaction; existing callers can ignore it. Never record then read "latest" to construct the result, because concurrent requests can interleave. Persist before emitting the corresponding live HookEvent and HTTP success; emit only sanitized title/message and the returned event ID, not arbitrary input. Reuse existing event publication and push wiring. A persistence failure must not emit success/live notification. Live events may repeat; UI maintains one notice per session, while durable logical duplicates do not trigger extra pushes.

PR validation: `normalizePullRequestUrl(value:string): string` in `bridge/src/pull-request-url.ts`. Accept only HTTPS `github.com/<owner>/<repo>/pull/<positive-safe-integer>` (optional trailing slash), no username/password, nondefault port, or extra path segments. Owner/repo are nonempty ordinary GitHub path names; reject encoded path delimiters/control characters. Strip query and fragment to the canonical PR URL; trim outer whitespace; maximum input 2048 chars. Never fetch the URL. Null is handled by the update operation; empty string is invalid. UI independently parses untrusted optional metadata and renders only valid links; malformed metadata never discards the whole session. A full snapshot without the optional field must clear an older link, not merge it back.

All `SessionController.update` calls must serialize the full per-session load→validate→mutate→save→publish boundary, covering existing name/parent and new PR fields together. Reuse the injected `withSessionWrite` when available and provide a small controller-local per-ID queue fallback for standalone/test controllers. This prevents concurrent metadata calls erasing each other's fields; it does not claim global transactionality across every historical storage writer. Add a deterministic concurrent rename+PR regression and mixed invalid-field/no-write regression. Independent reviewer required this bounded addition; no broader storage redesign is authorized.

## CLI and discovery

Both new self-actions use optional `--session-id <id>` to override trimmed `FTOWN_SESSION_ID`; no cwd, parent or latest-session fallback. Reject missing/invalid identity and invalid command inputs before transport. Consistent flags avoid ambiguous positional session ID versus PR URL.

```sh
ftown sessions attention --message "Please review the migration plan" [--title "Review requested"] [--session-id ID]
ftown sessions pr https://github.com/fmktech/ftown/pull/128 [--session-id ID]
ftown sessions pr --clear [--session-id ID]
```

Reject URL plus --clear, missing URL without --clear, surplus args and invalid URLs. CLI probes the relevant new capability before mutating old bridges and reports an upgrade-required error. Default JSON responses mirror HTTP. Existing `--plain` may provide a concise success summary. Add discoverable help and installed ftown skill/reference examples. Extend the existing MCP tool rather than adding a redundant PR-specific MCP operation.

## Lifecycle and UI

- Persist `pullRequestUrl` in Session and carry it through existing whole-session wire/list/update snapshots. Backend Session and wire types, UI Session type mirror the exact optional field. Same-ID retry/resurrection/reload preserves it; fresh sessions/children/clones and revive-to-new-ID do not inherit it implicitly.
- Header: accessible compact `PR #123` link near session name with repository/full URL context; target `_blank`, rel `noopener noreferrer`, visible focus and usable touch target.
- Original expanded sidebar rows: compact noninteractive PR badge with accessible repo/full URL text. Do not nest a link/button inside the existing session button or change selection/drag semantics. The header supplies the clickable destination. No PR editor is required in the UI.
- Reuse existing manual-attention extraction, Needs attention section, alert, clear-on-selection and mobile navigation. No new UI notice store. Current attention UI is event-derived, not guaranteed to resurrect indefinitely from durable ledger after arbitrary reload. Push remains opt-in/hosted and preserves current eligible-harness/status restrictions; Solo has no Web Push.

## Compatibility and consumer walkthrough

Changes are additive: optional metadata, optional capability flags, new route/tool/CLI commands. Old readers ignore new fields; new tools probe old bridge support. Preserve attention version 1 and existing record format. Breaking input/field semantics require the existing package release/version process; no speculative v2/compatibility framework.

Journey A: agent self env → CLI identity/capability check → request attention → persisted exact event returned → existing live sidebar/alert and eligible push → user selects/responds through existing flow. MCP substitutes authorized explicit machine/session for local env. Returned event ID is usable with existing inbox/ack/resolve operations; ack/resolve do not answer prompts.

Journey B: agent creates a GitHub PR using its existing tools → passes URL to CLI or sessions_update → controller validates all inputs, persists and publishes full session → header/sidebar update → list/reload returns same URL → replacing/clearing uses same operation. No GitHub permission or remote API call is needed. Walkthrough passes with the capability flags and exact event return specified above.

## Ownership, checks and execution

The exact ownership manifest is authoritative; one writer per file, shared checkout, explicit gpt-6.1-sol/high workers, no recursive delegation. Root owns this contract, coordination, sole CI/E2E/browser execution and cleanup. Native workers: backend `/root/attention_implementation`; CLI/MCP/docs/release + designated Git owner `/root/npx_implementation`; UI `/root/session_ui`; independent read-only review `/root/npx_review`. Git mutations only in a separate explicit landing lease after writers stop. Preserve four unrelated dirty notes (hash baseline `/tmp/ftown-session-attention-pr-notes-before.json`).

Acceptance: focused backend tests for validation atomicity, exact concurrent attention response, persistence failure/no event, duplicate logical event/push, auth/status/capabilities, PR attach/replace/clear/persistence; CLI and real MCP tests for self/explicit targeting, read-only visibility and old bridge failures; rendered UI safety/clear behavior; root-run real browser/CLI flow at desktop/mobile with screenshots and harmless scratch shell sessions. Existing real MCP HTTP tests may run as isolated unit/integration checks, without E2E services.

Provider inventory: checked-in FTown workflows currently use GitHub-hosted `ubuntu-latest`; no Agent37 runner/controller wiring exists here. Preserve existing trusted workflow routing for this feature; do not claim a migration or silently use Boat for CI. Boat is the development-check provider using one bounded task-owned sandbox and exact shared-checkout snapshot, no stored secrets, finite TTL and verified cleanup. Root retains exclusive E2E ownership. No local or remote production database/deployment selectors.

Review/dispatch: `/root/npx_review` approved the draft with the bounded metadata-serialization addition now incorporated above. All 34 owned paths passed mechanical equal/ancestor overlap checks. Discovery and review workers stopped without write leases. Three implementation scopes may proceed in parallel against this frozen contract; only root may change it and rebrief affected workers. Source handoffs must identify tests/commands and release file leases before integration.

Development resource: root created Boat sandbox `bx_k5bkykpb`, type small (2 vCPU/4GB), no stored environment, no snapshots, TTL 3600 seconds. No suitable existing FTown project snapshot was available (listed snapshots belonged to another project). Root owns setup/source transfer; workers may not start another sandbox or use this one until handed an exclusive check lease. This is development validation only, not CI or a separate coding checkout. Primary shared source remains the checkout above. Sampled Mac CPU returned to 65.7% idle with no new swapouts; the provider choice follows the user's development preference, not an unsupported pressure claim.

## Validation handoff

All three implementation workers stopped and released their exact file scopes. Independent reviewer `/root/npx_review` approved the combined source after two E2E assertion repairs: use the actual AttentionItem response shape and assert the existing keyboard box-shadow focus ring. No remaining material source findings.

Boat exact-source development checks passed on Node 24.22.1: bridge production build; 885 bridge tests passed with 4 existing skips; 17 release tests; 400 UI tests; UI and E2E TypeScript checks. All command exit codes were zero. Root then exclusively acquired E2E resources, confirmed no existing Docker services/test HOME and no effective remote database/deployment selectors, and verified ports 443/3000/5432/8000 were unused. Test database is private sandbox localhost Postgres `ftown`; bridge HOME is `/home/user/ftown-check/e2e/.bridge-home`. Root focused runtime and screenshot gate subsequently passed (see final evidence below).

First focused runtime run: production UI build and real scratch-bridge `ftown harness status` passed; existing manual-attention desktop/mobile tests passed. Both new tests failed their initial keyboard-focus assumption. Source diagnosis: xterm maps Shift+Tab to terminal ESC[Z and cancels the browser event; the test had tabbed from the header link into xterm, then incorrectly expected Shift+Tab to navigate back. UI worker is repairing only the keyboard navigation sequence to reach the link from a preceding UI control, retaining focus/ring assertions; no product focus bypass or application change. Root captured traces/screenshots in `/tmp/ftown-session-tools-first-e2e`; test-owned services and Docker infra stopped successfully.

Final root-owned runtime gate: the two new real-CLI flows passed on desktop (1280px) and mobile (390px), covering self identity and explicit override, attention ledger attribution/live shortcut/clear-on-selection, PR canonicalization/opening via intercepted external navigation, persistence/reload, replacement and clearing, untouched observer session, touch size, keyboard focus and no horizontal overflow. The two unchanged manual-attention flows passed in the prior run. Root visually reviewed all four new screenshots: attention plus sidebar PR badge and selected-session header link on both viewports. Source hashes for all 32 application/test files exactly matched the final shared checkout. Runtime artifacts were preserved locally at `/tmp/ftown-session-tools-passed-e2e`; all recorded services and Docker resources were confirmed stopped/removed. No remote production database or deployment was used.

Independent source/repaired-test review is complete; backend and UI workers have stopped and released leases. Native completed status is the available retirement mechanism. Integration owner retains only the concrete final compiler/landing assignment. No new application change followed the passing build/unit evidence.

Cleanup and landing: final E2E TypeScript check passed after the test-only navigation repair. Root deleted task-owned Boat sandbox `bx_k5bkykpb` and verified it was absent from the sandbox inventory at 2026-10-23T20:45Z. Other project sandboxes were untouched. All source/runtime leases are released. Integration owner `/root/npx_implementation` may stage only the 34 manifest paths, preserve the four unrelated note hashes, commit/push the feature branch and open a PR against main; merge/deployment remains unauthorized. Root owns monitoring the repository's existing automatic CI.
