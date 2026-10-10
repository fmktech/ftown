---
type: investigation
symptom: "All four MCP computers unavailable: three bridge errors and one timeout"
slug: mcp-legacy-bridges
date: 2026-10-10T08:25:00-03:00
git_commit: 16bc69ac857d8bf88596d0f0af9dc5775c183a05
branch: feat/agent-control-mcp
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 2
hypotheses_proven: 1
---

## Symptom
User: "it doesnt work at all". MCP machines_list returns three bridge_error results and one timeout; sessions_list cannot retrieve active sessions. Expected: connected computers expose their sessions.

## Reproduction
From the deployed gateway, connect to the configured owner's Centrifugo channel using its runtime credentials. Publish a correlated mcp_request GET /api/sessions to each configured bridge, then list_sessions. Scratch probe: /tmp/ftown-mcp-relay-probe.mjs. No agents are modified.

## Hypotheses
### H1: Existing bridges reject the gateway's new command (tooling/build)
- Prediction: mcp_request fails explicitly while the existing list_sessions command succeeds.
- Verification: publish both through the same authenticated subscription.
- Evidence: `"error":"Unknown command type: mcp_request"` from bridges 277066ac, cc184a54, eb512def. Their list_sessions responses are `"success":true` with sessionCount 7, 22, 21 respectively.
- Verdict: PROVEN. Gateway requires an unrolled worker protocol version and hides the diagnostic behind a generic bridge_error.

### H2: Relay connectivity or ownership credentials prevent every request (dependency/config)
- Prediction: old and new commands both fail on all computers.
- Evidence: three successful list_sessions responses over the same channel and credentials as the failing commands.
- Verdict: REJECTED for the three connected computers. Foad-Legion times out on both commands and remains a separate connectivity limitation.

### H3: The workers' local session APIs are unavailable or broken (code/integration)
- Prediction: an existing bridge_exec command reading its own authenticated loopback API also fails.
- Verification: /tmp/ftown-mcp-legacy-probe.mjs sends a fixed read-only Node helper, keeping the token on each worker.
- Evidence: each connected worker returned `"status":200`, counts 7/22/21, and matching bridgeId. Node versions v24.13.0, v24.12.0 and v22.21.1. No credentials returned.
- Verdict: REJECTED.

## 5 Whys
1. Session discovery fails because workers reject mcp_request.
2. They predate the new gateway command.
3. Gateway and worker rollout were coupled without capability negotiation.
4. Gateway deployment was verified before worker compatibility was required; worker restarts would terminate active direct-runtime agents.
5. Release acceptance covered the hosted service, not a usable existing fleet. Compatibility and a live fleet test must be release gates.

## Falsification
Kept the network, identity and target identical; changed only the command to list_sessions and then bridge_exec reading the local API. Both succeeded on all three responding workers, ruling out an unrelated transport or session API failure.

## Fix plan
Use the existing owner-scoped RPC only after an exact unknown-mcp-command rejection. Stop/retry use their existing RPC commands; other operations use a fixed, validated loopback request helper through bridge_exec. Encode all request data, enforce machine identity, deadline, response bounds and no redirects, never expose credentials, and never retry a timeout or ambiguous mutation. Keep the modern transport preferred. Preserve direct-runtime agents. Test the legacy path with a real isolated broker and verify live fleet discovery before claiming resolution.
