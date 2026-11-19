# Direct Transport Contract (FROZEN)

Historical implementation contract. The former `loops:updates` channel is
superseded by [automation retirement](../automation-sunset.md) in bridge 0.19.38;
the current control plane below omits that retired namespace.

WebRTC DataChannel direct data plane between `bridge/` and `ui/`, with Centrifugo as
control plane, signaling channel, and fallback data plane. This contract is immutable
for the duration of the implementation. Wire types live in:

- `bridge/src/direct-transport/contract.ts`
- `ui/src/lib/direct-transport/contract.ts`

The two files contain identical wire types (packages are independent; types are
duplicated by project convention, see `bridge/src/types.ts` / `ui/src/types.ts`).

## Architecture

```
Control plane (always Centrifugo):  sessions:updates, events:*,
                                    bridges:presence, commands:rpc (incl. signaling,
                                    watch heartbeats)
Data plane (preferred):             WebRTC DataChannel — terminal output/screen/input/resize
Data plane (fallback):              Centrifugo terminal:{sessionId}#{userId} and
                                    terminal-input:{sessionId}#{userId} (unchanged wire format)
```

## Rules (behavioral invariants)

R1. Exactly ONE active terminal data path per (client, session) at a time: `direct` or
    `centrifugo`. Every switch is followed by a full screen resync before incremental
    output (bridge sends `screen` on direct attach; bridge publishes a `screen_dump`
    to Centrifugo when a session gains its first remote watcher).

R2. Bridge publishes terminal output/screen to Centrifugo **iff** the session has at
    least one unexpired remote watcher (WatchRegistry). Direct-attached peers always
    receive output on their DataChannel. Session lifecycle/state updates are NOT
    gated — only `terminal:*` traffic is.

R3. A client using the direct path for a session MUST NOT subscribe to that session's
    `terminal:*` Centrifugo channel and MUST NOT send watch heartbeats for it.
    A client on the fallback path sends `terminal_watch` every `WATCH_HEARTBEAT_MS`
    (20 000) and `terminal_unwatch` on teardown; the bridge expires watchers after
    `WATCH_TTL_MS` (60 000).

R4. Bridge accepts terminal input from BOTH paths at all times (DataChannel `input`/
    `resize` messages and the existing `terminal-input:*` channel).

R5. Signaling flows over the existing `commands:rpc#{userId}` channel using the new
    command types below. No Centrifugo config changes. No new namespaces.

R6. Pairing is client-initiated. Client offers; bridge answers. ICE: host candidates +
    `stun:stun.l.google.com:19302`. No TURN — if ICE fails or the channel does not
    open within `PAIR_TIMEOUT_MS` (4 000), the client falls back to Centrifugo
    silently. Bridge tears down a peer on `webrtc_close`, ICE disconnect > 10 s, or
    missed pings (`PING_INTERVAL_MS` 15 000, dead after 2 missed).

R7. Existing Centrifugo wire formats are unchanged. `seq` is added to direct-path
    `output`/`screen` messages only (monotonic per session per peer, for
    debugging/sanity — receivers ignore gaps after a `screen` resync).

R8. No backwards compatibility shims. UI and bridge ship together.

## Extension: dashboard commands on the direct channel (bridge 0.30.43)

The direct channel (WebRTC DataChannel or loopback WebSocket) also carries the dashboard's commands, so the relay is left with
connection setup. The terminal rules above are unchanged.

Bridge:

- Once the channel is authorized, a bridge that serves commands sends `{ kind: 'capabilities', commands: true }`. Older clients
  ignore the frame.
- A command is a sealed application with a `command` route, bound to the channel's own name like terminal frames, and runs
  through the same admission, dispatch and update observer as on the relay. Connection setup and watch commands
  (`webrtc_*`, `terminal_watch`, `terminal_unwatch`) and HTTP routes are not accepted and end the channel.
- The answer is a sealed `response` for the request id. An answer larger than one DataChannel message is split into
  `id.index.total.payload` text frames (`bridge/src/direct-transport/framing.ts`); a frame never starts with `{`.

Client:

- The first command to a bridge opens the direct channel; no terminal needs to be open. Commands are held while it connects:
  for 10 s from the first attempt (or from the loss of a working channel) failed attempts are retried every 0.5 s. After that
  window commands are no longer held: the relay carries them and a new attempt starts in the background at most every 15 s.
- Against a bridge that connects but never announces command support (older version), commands use the relay.
- Connection setup commands and the security commands (`security_*`: pairing, devices, revocation) always use the relay.
- Each direct attempt has its own request id. A read that is not answered properly within 8 s is repeated over the relay under
  the original id. A command that changes something is never repeated once it has left: if the channel is lost first, the
  caller is told delivery is uncertain. A command that never left the browser may use the relay.

## Extension: a local bridge without the relay

A browser on the same machine as a bridge can list, read and drive it while the relay is unreachable. Browser-only change; no
bridge version is required.

- **Remembered port.** The browser keeps the localhost port each bridge was last advertised on (`ftown.bridgeLocalPorts.v1` in
  local storage) and the name it was shown under (`ftown.bridgeNames.v1`). Neither is a secret or grants anything: the encrypted
  hello on the connection is what identifies the bridge. A stale port costs one failed attempt.
- **Ladder order.** Remembered localhost port, then the port the relay advertises (only if different), then WebRTC, then the
  relay.
- **Connect on load.** For every approved bridge with a remembered port, the browser opens the localhost connection as soon as
  the page loads and again whenever approved bridges change, without waiting for the relay or for a first command.
- **Bridge list.** A bridge reached directly is listed even when relay presence does not report it.
- **Loading data.** When a bridge becomes ready while the relay is not connected, the command channel's `subscribed` signal is
  raised locally, which is what makes the dashboard read sessions and the rest. Commands then travel over the direct channel as
  described above.

Not covered: pushes (session updates, board, attention) still arrive only through the relay, so while it is down the page shows
what it last read and does not refresh by itself. A bridge on another machine still needs the relay to be introduced.

## Signaling wire types (over commands:rpc)

Envelope rides the existing commands-channel publish format. New `type` values:
`webrtc_offer`, `webrtc_answer`, `webrtc_ice`, `webrtc_close`, `terminal_watch`,
`terminal_unwatch`. See `SignalMessage` / `WatchMessage` in contract.ts. All carry
`bridgeId` and `clientId`; signaling carries `pairId` (one per connection attempt).
Messages not addressed to the receiver's own id are ignored.

## DataChannel protocol

Single DataChannel, label `ftown`, ordered+reliable, JSON text frames, protocol
version 1. Message union `DirectMessage` in contract.ts:
`hello`/`hello_ack` (version check — mismatch ⇒ close), `attach`/`detach` (per
session), `screen`, `output`, `input`, `resize`, `ping`/`pong`.
On `attach`, bridge replies with `screen` (full serialized screen, seq resets the
stream) before any `output` for that session. Unknown `kind` ⇒ ignore.

## Module APIs (public surface, frozen)

### Bridge (`bridge/src/direct-transport/`)

- `WatchRegistry` — `watch(sessionId, clientId)`, `unwatch(sessionId, clientId)`,
  `hasWatchers(sessionId): boolean`, `onFirstWatcher(cb: (sessionId) => void)`,
  `dispose()`. Timer-driven expiry (injectable clock for tests).
- `DirectPeerManager` — wraps `node-datachannel`. `handleSignal(msg: SignalMessage)`,
  `sendOutput(sessionId, data)`, `sendScreen(sessionId, data)`,
  `hasAttachedPeers(sessionId): boolean`, callbacks
  `onInput(sessionId, data)`, `onResize(sessionId, cols, rows)`,
  `onAttach(sessionId, cb)` (cb returns the current screen string to send),
  `closeAll()`. Emits answers/ICE via an injected `sendSignal(msg)` callback.
- `PublishRouter` — composes the two above plus the existing `CentrifugoClient`:
  `publishTerminalData(sessionId, data)`, `publishTerminalScreen(sessionId, screen)`
  implementing R2, and `handleCommand(msg)` dispatching signaling/watch commands.
  `index.ts` swaps direct `centrifugo.publishTerminal*` call sites to the router.

### UI (`ui/src/lib/direct-transport/`)

- `WebRtcPeer` — browser `RTCPeerConnection` wrapper implementing the DataChannel
  protocol and client side of signaling; constructor takes
  `{ bridgeId, clientId, sendSignal }`, exposes `connect(): Promise<void>` (rejects
  on timeout), `attach(sessionId, handlers)`, `detach`, `sendInput`, `sendResize`,
  `close()`, `onClose(cb)`.
- `HybridTerminalTransport` implements `TerminalTransportApi` (in contract.ts):
  `subscribeTerminal(sessionId, bridgeId, handlers): () => void`,
  `sendInput(sessionId, data)`, `sendResize(sessionId, cols, rows)`,
  `getMode(sessionId): 'direct' | 'centrifugo' | 'connecting'`,
  `onModeChange(cb)`, `dispose()`.
  Internally: attempt direct pairing per bridge (one peer per bridge, shared across
  sessions); on failure/close fall back per R1/R3. Constructor injects the Centrifugo
  client and a `publishCommand` function so it stays framework-free and testable.
- `useTerminal` consumes ONLY `TerminalTransportApi`. `DashboardClient`/`Dashboard`
  construct one `HybridTerminalTransport` per Centrifugo connection.

## Task ownership (exclusive)

| Agent | Owns |
|---|---|
| A1 bridge-dev | `bridge/src/direct-transport/*.ts` (non-test), `bridge/package.json`, wiring edits in `bridge/src/index.ts` + `bridge/src/centrifugo-client.ts` |
| A2 bridge-test | `bridge/src/direct-transport/*.test.ts` |
| A3 ui-dev | `ui/src/lib/direct-transport/*.ts` (non-test) |
| A4 ui-wire | `ui/src/hooks/useTerminal.ts`, `ui/src/hooks/useCentrifugo.ts`, `ui/src/components/DashboardClient.tsx`, `ui/src/components/Dashboard.tsx` |
| A5 ui-test | `ui/vitest.config.ts`, `ui/package.json` (test script/devDeps only), `ui/src/lib/direct-transport/*.test.ts` |

Gates — bridge: `npm test` and `npm run build` in `bridge/`. UI: `npx tsc --noEmit`,
`npm run lint`, and (A5) `npx vitest run` in `ui/`.
