---
type: investigation
symptom: "Terminal badge shows Cloud (Centrifugo fallback) instead of P2P on user's real setup — new bridge (0.14.0) + new front, browser and bridge on the same machine"
slug: direct-transport-shows-cloud
date: 2026-07-05T00:00:00-03:00
investigator: Foad Kesheh
git_commit: 9b7b33f
branch: feat/docs-and-mode-badge
repository: fmktech/ftown
status: root-cause-proven
hypotheses_formed: 5
hypotheses_rejected: 4
hypotheses_proven: 1
related:
  - docs/plans/direct-transport-contract.md
---

# Direct transport shows Cloud instead of P2P on real setup

## Symptom
- **Observed**: User report (verbatim): "I'm on the new bridge and front, I only see cloud". The terminal transport badge (merged in PR #22) renders "Cloud" — i.e. `HybridTerminalTransport` mode is `centrifugo` — on the user's own machine where the bridge runs locally.
- **Expected**: On the same machine (loopback/LAN), WebRTC pairing should complete within PAIR_TIMEOUT_MS (4s) and the badge should show "P2P" (`mode === 'direct'`), per docs/plans/direct-transport-contract.md R6.
- **Delta**: Pairing never reaches `direct`; the transport silently falls back to Centrifugo despite browser and bridge sharing a machine.

## Environment facts (verified 2026-07-05)
- PR #22 (badge + docs) MERGED → deployed front includes the badge. Verified: `gh pr view 22` → MERGED.
- Bridge running via `npx ftown-bridge@latest`; installed cache shows `"version": "0.14.0"` and `dist/direct-transport/` present. `npm view ftown-bridge version` → 0.14.0.
- VPN OFF at investigation time: `route -n get default` → `interface: en0`, `gateway: 192.168.68.1` (LAN, not utun). The previously proven VPN/ICE failure mode does not apply to the current observation window.
- CI e2e Test A ("direct proven in CI") launched Chromium with `--disable-features=WebRtcHideLocalIpsWithMdns` (e2e/playwright.config.ts:40) — real Chrome's DEFAULT mDNS candidate obfuscation has never been exercised anywhere.

## Reproduction
Planned recipe (delegated run): local stack (Centrifugo :8000, UI next start :3000, bridge 0.14.0-equivalent branch build with isolated HOME) + REAL Chrome (Playwright `channel: 'chrome'`, headed) with DEFAULT flags (no mDNS-disabling arg), open a session terminal, observe transport mode after >5s.
- Symptom reproduced if mode stays `centrifugo`.

## Hypotheses

#### H1: Full-tunnel VPN breaks ICE (the previously proven local failure mode)
- **Layer**: config-env
- **Prediction**: If true, `route -n get default` shows a utun interface as default route while the user observes Cloud.
- **Verification method**: `route -n get default` on the machine at observation time.
- **Evidence**:
  ```
  gateway: 192.168.68.1
  interface: en0
  ```
- **Verdict**: REJECTED (for the current observation)
- **Rationale**: The supposed cause is absent (VPN off, default route via en0) yet the bug still manifests — direct counterexample. Caveat: if the user's earlier observation happened with VPN up, H1 explains *that* instance; it cannot explain a failure reproduced now.

#### H2: Chrome's default mDNS host-candidate obfuscation prevents ICE with node-datachannel
- **Layer**: dependency-integration
- **Prediction**: If true: real Chrome with default flags fails to pair (mode `centrifugo`), AND the identical run with `--disable-features=WebRtcHideLocalIpsWithMdns` pairs (mode `direct`). RTC trace shows only `.local` mDNS host candidates offered by Chrome.
- **Verification method**: A/B experiment via local stack + Playwright real-Chrome channel, toggling only the mDNS flag; capture candidates + iceConnectionState.
- **Evidence**: pending
- **Verdict**: INCONCLUSIVE (pending experiment)

#### H3: Inbound signaling (webrtc_answer/webrtc_ice) never reaches the browser transport in the deployed topology
- **Layer**: code-logic / state-data
- **Prediction**: If true, browser-side peer never gets setRemoteDescription (RTC internals show no remote description / no remote candidates) while bridge logs show an answer was published; badge falls back at exactly PAIR_TIMEOUT_MS.
- **Verification method**: RTC trace + bridge stdout during repro.
- **Evidence**: pending
- **Verdict**: INCONCLUSIVE (pending experiment)

#### H4: PAIR_TIMEOUT_MS (4s) too tight for cloud-Centrifugo signaling RTT
- **Layer**: config-env
- **Prediction**: If true, trace shows answer/ICE arriving shortly AFTER the 4s close; pairing succeeds against local Centrifugo (low RTT) but fails against wss.ftown.ia.br.
- **Verification method**: timestamps in RTC trace/bridge log; compare local-Centrifugo vs prod-Centrifugo signaling.
- **Evidence**: pending
- **Verdict**: INCONCLUSIVE (pending experiment)

#### H5: Badge is wrong — transport is actually direct but reports Cloud (observation artifact)
- **Layer**: observation
- **Prediction**: If true, DevTools WS frames show NO terminal:* publications while typing despite the Cloud badge.
- **Verification method**: Centrifugo channel presence check (authoritative) during repro while badge shows Cloud.
- **Evidence**: pending
- **Verdict**: INCONCLUSIVE (pending experiment)

## Experiment (three-way, real Chrome via Playwright channel:'chrome', headed, local stack, branch-built bridge)

- **Run A — Chrome defaults (mDNS obfuscation ON), WARP connected**: offer sent; answer `setRemoteDescription` at t+3.82s (~70ms after PC creation); all remote candidates delivered including the bridge's `192.168.68.52` en0 host candidate; Chrome offered mDNS host candidates (`candidate:... adbbbb12-….local 62156 typ host`); `ice=checking` forever; `dc CLOSE t+7.61s`; badge=Cloud; `terminal:*` subscriber present.
- **Run B — `--disable-features=WebRtcHideLocalIpsWithMdns`, WARP connected**: Chrome's host candidates became real IPs — but only WARP's (`172.16.0.2`, `2606:4700:…`), no en0, no loopback. Same failure: `dc CLOSE t+7.39s`, badge=Cloud.
- **Run C — WARP disconnected, Chrome FULL defaults (mDNS ON)**: paired instantly — `setRemoteDescription t+1.37s`, `ice=connected t+1.41s`, `dc OPEN t+1.43s`, badge=P2P, `terminal:*` subscriber ABSENT.
- Smoking gun: with WARP connected, BOTH peers' srflx candidates showed the SAME Cloudflare edge IP `104.28.160.118` — all WebRTC UDP egresses through WARP, which does not hairpin two local sockets.

## Hypothesis verdicts (final)

- **H1 (VPN-class UDP interception) — PROVEN in refined form**: the interceptor is Cloudflare WARP, which captures UDP without owning the visible default route. `route -n get default` → en0 is an insufficient detector; `warp-cli status` → "Connected" while `utun8` holds `172.16.0.2`. The original H1 rejection was evidence-based but the detection method was wrong.
- **H2 (Chrome mDNS obfuscation vs node-datachannel) — REJECTED**: Run C pairs in ~1.4s with obfuscation ON and WARP off; Run B fails with obfuscation OFF and WARP on. mDNS is not a factor; the CI flag is belt-and-braces, not a mask for a product bug.
- **H3 (inbound signaling broken) — REJECTED**: answer + full remote ICE arrived <100ms after PC creation in every run.
- **H4 (4s pair timeout too tight) — REJECTED**: signaling RTT ≈70ms; the timeout fired because ICE never validated, not because signaling was slow.
- **H5 (badge lying) — REJECTED**: badge truthful in both directions, cross-checked against authoritative Centrifugo channel presence (Cloud ⇔ subscriber present; P2P ⇔ absent).

## 5 Whys
Symptom:  Badge shows Cloud on the bridge's own machine.
Why 1?    ICE never validates a candidate pair, so the DataChannel never opens and the 4s pair timeout triggers silent fallback.
Why 2?    Cloudflare WARP is connected and captures ALL UDP (both peers' srflx = the same Cloudflare edge IP), and WARP does not hairpin two local sockets back to each other; host-candidate checks also die inside the tunnel.
Why 3?    WARP intercepts at the socket/packet-filter layer without replacing the visible default route, so nothing in the product (or our earlier check) detected the condition.
Why 4?    The direct transport was designed with no ICE-failure diagnostics — a pairing failure is indistinguishable from "remote client" to the user (deliberate v1 trade-off: silent fallback).
Why 5?    Root cause is outside the codebase (endpoint security software policy on the user's machine). Product can only detect and explain, not fix.

## Falsification
- Check performed: counterfactual (Run C — cause removed, symptom gone: pairing succeeds in 1.43s) + adjacent-cause search (Run A/B isolate mDNS as the alternative cause; both fail with WARP on regardless of mDNS ⇒ mDNS rejected).
- Result: hypothesis survived. Reconnecting WARP restores the failure condition (Run A/B).
- Conclusion: H1-refined stands as root cause.

## Root Cause
- Immediate cause: Cloudflare WARP (Connected) intercepts all UDP on the machine; ICE connectivity checks cannot complete between two local sockets (evidence: identical Cloudflare srflx IP `104.28.160.118` on both peers; `ice=checking` → timeout in Runs A/B; instant `dc OPEN` in Run C with WARP off).
- Architectural root: outside the codebase — endpoint tunneling software. Product-level gap (follow-up, not defect): no user-visible diagnostics distinguishing "pairing failed: no ICE connectivity (VPN?)" from a normal remote fallback.
- Rejected H2: Run C passes with mDNS obfuscation on (WARP off).
- Rejected H3: answer + ICE delivered <100ms in all runs.
- Rejected H4: signaling completed ~70ms, timeout fired on ICE, not signaling.
- Rejected H5: badge matched authoritative Centrifugo channel state in all runs.

## Fix
- No product code change required — root cause is environmental (WARP). User remediation: disconnect WARP, or add a split-tunnel exclusion so local-network UDP bypasses the tunnel.
- Justification for no-code resolution: the failing component is vendor endpoint software outside our control; the transport's silent-fallback behavior on ICE failure is the contract's designed behavior (R6).
- Follow-up (filed as recommendation): surface a pairing-failure reason on the Cloud badge tooltip (e.g. "P2P unavailable — ICE blocked, check VPN") and/or a diagnostics line in bridge logs.

## Resolution
- Verification: Run C (WARP off) = badge P2P, DataChannel open in 1.43s, zero Centrifugo terminal subscribers, on the exact shipped code.
- Regression test: N/A for the environmental cause; the badge + Centrifugo-presence check used here is the standing detection method (and CI Test A covers the product path).
- Environment restored: diagnostic spec deleted, WARP left Connected as found, stack torn down.
