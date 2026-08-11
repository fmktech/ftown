# Pi extension API

The bundled Pi extension exposes ftown's authenticated local bridge API as a small set of model-callable tools. It uses camel-case JSON, opaque string identifiers, plural resource names, and wrapped success objects. Failures are returned to Pi as a tool error with a sanitized `{ "error": string }` detail object.

## Resource model

| Resource | Identity | Relationships | Lifecycle |
| --- | --- | --- | --- |
| Session | Opaque UUID, or a unique exact name for lookup | Optional parent session; owns inbox, usage, screen, and log | Create, inspect, rename, reparent, stop, remove, revive |
| Mail message | Assigned by the session inbox | Sent from one session to another; optional thread | Send, peek/read, delivered |
| Loop | Opaque ID, or a unique exact name for lookup | Owns loop runs | Create, inspect, update, run, delete |

All tools talk only to the local bridge selected by `FTOWN_HOOK_PORT` or `~/.ftown/bridge.json`. The extension supplies that bridge's bearer token and never sends credentials to the model.

## Tool contract

| Tool | Operation | Required input | Result | Mutation |
| --- | --- | --- | --- | --- |
| `ftown_mail` | `send` | `target`, `body` | Stored inbox message | Yes |
| `ftown_mail` | `read` | None | `{ messages }` for the current session | No |
| `ftown_sessions` | `list` | None | `{ sessions }` | No |
| `ftown_sessions` | `archive` | None | `{ archived }` tombstones | No |
| `ftown_sessions` | `get` | `target` | `{ session }` | No |
| `ftown_sessions` | `running` | `target` | `{ sessionId, running }` | No |
| `ftown_sessions` | `usage` | `target` | Session token/model usage | No |
| `ftown_sessions` | `screen` | `target` | Paginated terminal screen | No |
| `ftown_sessions` | `grep` | `target`, `pattern` | Paginated terminal-log matches | No |
| `ftown_session_create` | create | `shell`, `prompt` | Created session | Yes |
| `ftown_session_manage` | `stop` | `target` | Stop acknowledgement | Yes |
| `ftown_session_manage` | `rename` | `target`, `name` | Updated session | Yes |
| `ftown_session_manage` | `reparent` | `target`, `parent` | Updated session | Yes |
| `ftown_session_manage` | `remove` | `target` | Removal acknowledgement | Yes |
| `ftown_session_manage` | `revive` | `target` | Recreated session and resume state | Yes |
| `ftown_loops` | `list` | None | `{ loops }` | No |
| `ftown_loops` | `get` | `target` | `{ loop }` | No |
| `ftown_loops` | `create` | `name`, `task`, `schedule` | `{ loop }` | Yes |
| `ftown_loops` | `update` | `target` and changed fields | `{ loop }` | Yes |
| `ftown_loops` | `delete` | `target` | Removal acknowledgement | Yes |
| `ftown_loops` | `runs` | `target` | Loop run history | No |
| `ftown_loops` | `run_now` | `target` | Requested loop run | Yes |

`target` accepts an opaque ID or a unique exact name. Mail additionally accepts `parent`. Reparenting with `parent: null` clears the parent. Session and loop creation intentionally accept structured fields only; arbitrary session commands, environment variables, and loop preflight/postflight shell commands are not part of the model-facing contract.

The extension also registers `/ftown-mail read [--peek]`, `/ftown-mail send <session> <message>`, and `/ftown-sessions` for interactive use.

## Mail wake-up

After `session_start`, the extension maintains one authenticated, cancellable
30-second long-poll against the current session's inbox. Incoming messages are
injected through Pi's native `sendUserMessage(..., { deliverAs: "followUp" })`
API. This starts a turn immediately while Pi is idle and safely queues a
follow-up while Pi is streaming. The listener retries bridge errors with capped
exponential backoff and is aborted during `session_shutdown`; it never types
into the terminal.

## Authorization and safety

The local bridge bearer token authorizes access to the current ftown user's bridge resources. Session name resolution is performed against that same authenticated bridge. The model can inspect a terminal screen or search its captured log, but it cannot inject raw terminal keystrokes, resize terminals, clear terminal history, or call hook/conversation-resolution internals through these tools.

Mutation executions are deduplicated in the running extension by `(tool name, Pi tool-call ID)`, including concurrent retries. Failed attempts are not cached. This prevents a retried model tool call from duplicating mail, sessions, management actions, or loop runs; it is not a durable idempotency key across Pi process restarts.

## Pagination and errors

Inbox reads accept `limit` from 1 to 100. Screen and log operations accept zero-based `offset`; screen `limit` is 1 to 1,000, log `limit` is 1 to 1,000, and grep context is 0 to 10 lines. Session and loop collection endpoints currently return the bridge's complete local collection and inherit its unpaginated behavior.

Transport failures, missing/ambiguous names, unavailable parent context, validation failures, and bridge `{ "error": string }` responses become Pi tool errors. No response body, token, stack trace, or upstream URL is exposed to the model.

## Compatibility

The tool schemas ship with `ftown-bridge` and follow its semantic version. Adding an optional property or operation is additive. Renaming/removing a tool, operation, required field, or result field is breaking. The underlying local HTTP API is deliberately hidden behind these tool contracts so bridge route changes do not require prompt changes.

## Consumer walkthrough

An agent can call `ftown_sessions.list`, use the returned session ID with `ftown_sessions.get` or `usage`, and then send context with `ftown_mail.send`. To delegate, it can create a child with `ftown_session_create`, retain the returned ID, inspect its output, and later rename, reparent, stop, remove, or revive it. For scheduled work, it can create or update a structured loop, request `run_now`, then inspect `runs` without leaving Pi.
