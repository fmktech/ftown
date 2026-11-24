# Pi and OMP extension API

Pi and Oh My Pi (OMP) load the bundled extension, which exposes ftown's authenticated local bridge API as a small set of model-callable tools. It uses camel-case JSON, opaque string identifiers, plural resource names, and wrapped success objects. Failures are returned as a tool error with a sanitized `{ "error": string }` detail object.

The [ftown skill](../skills/ftown/SKILL.md) documents the shell commands shared across harnesses. The tool names and JSON inputs below apply to the Pi and OMP extension.

## Resource model

| Resource | Identity | Relationships | Lifecycle |
| --- | --- | --- | --- |
| Session | Opaque UUID, or a unique exact name for lookup | Optional parent session; owns inbox, usage, screen, and log | Create, inspect, rename, reparent, stop, remove, revive |
| Discussion thread | Thread ID | Belongs to a project channel on the project’s home bridge | Read and post with `ftown discuss`, reply with `ftown_discuss` |
| Mail message | Assigned by the session inbox | Direct session messages can be grouped by inbox thread | Send, peek/read, delivered |

Tools that access the bridge use the local bridge selected by `FTOWN_HOOK_PORT` or `~/.ftown/bridge.json`. The extension supplies that bridge's bearer token and never sends credentials to the model.

## Tool contract

| Tool | Operation | Required input | Result | Mutation |
| --- | --- | --- | --- | --- |
| `ftown_ask_user` | — | `question` | Interactive answer or cancellation | No |
| `ftown_mail` | `send` | `target`, `body` | Stored direct session message | Yes |
| `ftown_discuss` | `reply` | `project`, `threadId`, `text` | Stored thread post ID | Yes |
| `ftown_mail` | `read` | None | `{ messages }` for the current session | No |
| `ftown_sessions` | `list` | None | `{ sessions }` | No |
| `ftown_sessions` | `children` | None | Child sessions of `target` or the current session | No |
| `ftown_sessions` | `archive` | None | `{ archived }` tombstones | No |
| `ftown_sessions` | `get` | `target` | `{ session }` | No |
| `ftown_sessions` | `running` | `target` | `{ sessionId, running }` | No |
| `ftown_sessions` | `usage` | `target` | Session token/model usage | No |
| `ftown_sessions` | `screen` | `target` | Paginated terminal screen | No |
| `ftown_sessions` | `grep` | `target`, `pattern` | Paginated terminal-log matches | No |
| `ftown_session_create` | create | `prompt` | Created session | Yes |
| `ftown_session_manage` | `stop` | `target` | Stop acknowledgement | Yes |
| `ftown_session_manage` | `rename` | `target`, `name` | Updated session | Yes |
| `ftown_session_manage` | `reparent` | `target`, `parent` | Updated session | Yes |
| `ftown_session_manage` | `remove` | `target` | Removal acknowledgement | Yes |
| `ftown_session_manage` | `revive` | `target` | Recreated session and resume state | Yes |

`target` accepts an opaque ID or a unique exact name. Mail additionally accepts `parent`. Reparenting with `parent: null` clears the parent. Session creation intentionally accepts structured fields only; arbitrary session commands and environment variables are not part of the model-facing contract.

The extension also registers `/ftown-mail read [--peek]`, `/ftown-mail send <session> <message>`, and `/ftown-sessions` for interactive use.

Project discussion notifications carry a thread ID. Use `ftown_discuss` with `operation: "reply"`, the project ID or name, the thread ID and your reply text. Supply `bridge` to address a particular project home. A retry of the same tool call reuses its post ID.

## Mail wake-up

After `session_start`, the extension maintains one authenticated, cancellable
30-second long-poll against the current session's inbox. Incoming messages are
injected through the harness’s native `sendUserMessage` API. Pi accepts
`deliverAs: "followUp"` both when idle and when streaming. OMP starts an idle
turn with a normal message and uses `followUp` during an active turn. The listener retries bridge errors with capped
exponential backoff and is aborted during `session_shutdown`; it never types
into the terminal.

## Authorization and safety

The local bridge bearer token authorizes access to the current ftown user's bridge resources. Session name resolution is performed against that same authenticated bridge. The model can inspect a terminal screen or search its captured log, but it cannot inject raw terminal keystrokes, resize terminals, clear terminal history, or call hook/conversation-resolution internals through these tools.

Mutation executions are deduplicated in the running extension by `(tool name, native tool-call ID)`, including concurrent retries. Failed attempts are not cached. This prevents a retried model tool call from duplicating mail, sessions, or management actions; it is not a durable idempotency key across process restarts.

## Pagination and errors

Inbox reads accept `limit` from 1 to 100. Screen and log operations accept zero-based `offset`; screen `limit` is 1 to 1,000, log `limit` is 1 to 1,000, and grep context is 0 to 10 lines. Session collection endpoints currently return the bridge's complete local collection and inherit its unpaginated behavior.

Transport failures, missing/ambiguous names, unavailable parent context, validation failures, and bridge `{ "error": string }` responses become tool errors. No response body, token, stack trace, or upstream URL is exposed to the model.

## Compatibility

The tool schemas ship with `ftown-bridge` and follow its semantic version. Adding an optional property or operation is additive. Renaming/removing a tool, operation, required field, or result field is breaking. The underlying local HTTP API is deliberately hidden behind these tool contracts so bridge route changes do not require prompt changes.

## Consumer walkthrough

Call `ftown_sessions` with `{"operation":"list"}` to find a session. Use its ID as `target` with operation `get` or `usage`. To send the session an instruction, call `ftown_mail` with `{"operation":"send","target":"<session-id>","body":"Review the API client"}`. For a shared discussion, call `ftown_discuss` with `operation: "reply"`, `project`, `threadId` and `text`. To delegate work, create a child with `ftown_session_create` and use the returned ID with `ftown_session_manage`.

The ftown extension is installed by explicit `ftown setup`; use
`ftown setup --repair` after installing a new optional harness. Structured creates
use ordinary task and parent inputs. Legacy orchestrator booleans are ignored.
