# Loopback WebSocket Transport — Contract Addendum (FROZEN)

Extends docs/plans/direct-transport-contract.md. All original rules R1–R8 stand.
Motivation: VPN/endpoint filters (Cloudflare WARP proven, docs/investigations/
2026-07-05-direct-transport-shows-cloud.md) kill UDP hairpin but leave loopback
TCP untouched. A same-machine WebSocket rung bypasses them.

## Transport ladder (replaces the binary direct/fallback choice)

```
1. loopback WS   ws://127.0.0.1:{port}/ws?nonce=…  — same machine only, TCP
2. WebRTC        DataChannel — LAN / same machine when UDP works
3. Centrifugo    cloud fallback — always works
```

Rungs are tried in order per bridge; a rung failing (timeout/refused/closed)
falls to the next. R1 (single active path per session + resync on switch) and
R2–R4 (watch-gated cloud publishing, input accepted from all paths) apply to
BOTH local rungs identically: a loopback-attached peer counts as direct-attached
for publish routing.

## New rules

L1. The bridge exposes a WebSocket upgrade at path `/ws` on its EXISTING
    loopback-only local API server (127.0.0.1, ephemeral port). Upgrade requires
    `?nonce=<LOCAL_NONCE>` matching the bridge's current nonce AND an Origin
    header that is either the configured api-url origin or a localhost origin.
    Reject otherwise (HTTP 403 before upgrade).
L2. The bridge advertises `{ localPort: number, localNonce: string }` via the
    connection JWT `info` claim: it sends both fields in the POST
    /api/auth/bridge (and refresh) body — the UI route validates them
    (localPort integer 1-65535, localNonce 32-char lowercase hex; both-or-
    neither, else 400) and embeds them in the Centrifugo connection token's
    `info`, which Centrifugo exposes as presence `conn_info` on
    bridges:presence. (Subscription `data:` is NOT used — Centrifugo ignores
    it without a subscribe proxy; bug caught by e2e.) The nonce is generated
    per bridge process start (crypto-random, 16 bytes hex), never logged.
    Presence is only visible to the owning user's JWT holders — nonce
    possession + loopback reachability proves same user, same machine.
L3. Wire protocol over the WS: EXACTLY the DirectMessage JSON frames from
    contract.ts (hello/hello_ack/attach/detach/screen/output/input/resize/
    ping/pong), same semantics, same seq rules, same chunking limits. hello_ack
    gates all other frames, as in WebRTC.
L4. Client rung attempt: only when the bridge's presence advertises
    localPort+localNonce. Timeout LOOPBACK_TIMEOUT_MS = 1_500 (TCP connect +
    hello round-trip on loopback). Any failure → WebRTC rung. Safari's
    mixed-content block on ws://127.0.0.1 manifests as a connection error →
    natural fallthrough.
L5. New TerminalTransportMode value `'local'` (additive union extension):
    mode is 'local' when the session is attached over the loopback WS.
    Badge: label "Local", accent styling like P2P, tooltip "Terminal connected
    over a local socket — data never leaves this machine." FallbackReason
    semantics unchanged ('pairing_failed' covers both local rungs failing;
    'peer_lost' covers an open local/WebRTC path closing mid-session).
L6. The client obtains the bridge's advertised local info by querying presence
    on the bridges channel through the injected Centrifuge client at pairing
    time (no TerminalTransportApi signature changes; internal concern).

## Module surface (frozen)

Bridge (new file bridge/src/direct-transport/loopback-server.ts):
- `class LoopbackPeerServer` — attaches to the existing local API http.Server
  (upgrade handler). Constructor: `{ nonce, allowedOrigins, onInput, onResize,
  onAttach, bridgeId }` (mirrors DirectPeerManager callbacks). Methods:
  `sendOutput(sessionId, data)`, `sendScreen(sessionId, data)`,
  `hasAttachedPeers(sessionId)`, `closeAll()`. Same chunking/seq helpers as
  peer-manager (extract/share only if trivial; duplication acceptable).
- PublishRouter gains an OPTIONAL `loopback?: LoopbackPeerServerLike` in its
  options (additive): output/screen fan out to BOTH peer managers;
  `hasAttachedPeers` = either.

UI (new file ui/src/lib/direct-transport/loopback-peer.ts):
- `class LoopbackPeer` — implements the SAME public surface as WebRtcPeer
  (connect/attach/detach/sendInput/sendResize/close/onClose), over a browser
  WebSocket to `ws://127.0.0.1:{port}/ws?nonce=…`. Injectable WebSocket factory
  for tests.
- HybridTerminalTransport: per-bridge ladder loopback→webrtc→centrifugo, one
  active peer per bridge as today; peer entry records which rung it is
  (`kind: 'local' | 'webrtc'`) driving mode 'local' vs 'direct'.

## E2E semantics change

Existing Test B (WebRTC disabled ⇒ Cloud) becomes: WebRTC disabled on the same
machine ⇒ mode 'local' via loopback WS (P2P-class). To force the cloud fallback
a test must ALSO make the loopback rung unavailable (e.g. strip localPort from
presence or block the WS). Add Test C accordingly:
- B': RTCPeerConnection undefined ⇒ badge Local, no terminal:* subscriber.
- C: RTCPeerConnection undefined AND loopback unavailable ⇒ badge Cloud,
  subscriber present.
