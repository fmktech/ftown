# Direct Transport Contract (FROZEN)

WebRTC DataChannel direct data plane between `bridge/` and `ui/`, with Centrifugo as
control plane, signaling channel, and fallback data plane. This contract is immutable
for the duration of the implementation. Wire types live in:

- `bridge/src/direct-transport/contract.ts`
- `ui/src/lib/direct-transport/contract.ts`

The two files contain identical wire types (packages are independent; types are
duplicated by project convention, see `bridge/src/types.ts` / `ui/src/types.ts`).

## Architecture

```
Control plane (always Centrifugo):  sessions:updates, loops:updates, events:*,
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
