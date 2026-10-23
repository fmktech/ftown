# npm/runtime security handoff

Implementation owner: `/root/npx_implementation`, explicit `gpt-6.1-sol` / `high`; shared checkout and base match coordination.md. Sole dependency/Git writer. Four pre-existing notes SHA256-verified before branch preparation; no application source ownership or E2E execution.

## Approved groups and evidence

Bridge audit: two moderate runtime package nodes, `express-rate-limit -> ip-address 10.7.3` and `centrifuge -> protobufjs 7.6.4`. Raw baseline `/tmp/ftown-bridge-audit-2026-10-23.json`. UI baseline and all intermediate upstream release notes are retained in the evidence directory named by coordination.md. Groups are applied serially; no force upgrades or global runtime changes.

- IP 10.7.4 removes quadratic IPv6-zone rejection; accepted addresses unchanged. `RE_ZONE_STRING` is deprecated, has no FTown callers. [Advisory](https://github.com/beaugunderson/ip-address/security/advisories/GHSA-rxp7-6hxx-x8q5), [complete patch comparison](https://github.com/beaugunderson/ip-address/compare/v10.7.3...v10.7.4).
- Protobuf 7.6.5 checks schema EOF; 7.6.6 tightens malformed message/varint bounds and Any recursion. FTown uses default JSON Centrifuge (`bridge/src/centrifugo-client.ts`), not untrusted schema parsing or the protobuf entrypoint. [Advisory](https://github.com/protobufjs/protobuf.js/security/advisories/GHSA-j3f2-48v5-ccww), [7.6.5 release](https://github.com/protobufjs/protobuf.js/releases/tag/protobufjs-v7.6.5), [7.6.6 release](https://github.com/protobufjs/protobuf.js/releases/tag/protobufjs-v7.6.6). UI crosses additional 7.5/7.6 fixes captured in the supplied changelog.
- Next 15.5.14–28 security/backport notes and Auth beta.31–32/core 0.41.1–3 notes reviewed. App Router and MCP consent Server Action are used; no direct next/image, next/og, Cache Components or email/OAuth-provider use. Next rejects TypeScript >=7 (project remains 5.9); Auth now fails closed on non-OK session responses. Root browser login/session/signout will verify those used boundaries. The upstream v15.5.17 release endpoint is absent in supplied evidence; report this release-note gap rather than infer its contents.
- PostCSS source-map loading is stricter; retain safe defaults and scope the Next override only. UUID patch is used for v4; no broad UUID major. Vitest/Vite/Undici changes remain development-only. Exact final versions/transitive movement and checks follow below.

## Runtime scope and limits

Process-local official Node 24.22.1 (bundled npm 11.19.1), SHA256 verified by root; user's global runtime unchanged. Registry manifest inspection confirmed linux/amd64 and linux/arm64 for Node 22.23.4/24.22.1 alpine and bookworm-slim tags; no images built or run by this worker. Keep existing Docker Node major. UI's Node range allows patched 22/24 and highest matching managed hosting major24; engines/config are not proof of a deployed hosting patch.

The Solo Dockerfile pin moves from ftown-bridge@0.19.41 to this release, 0.19.50. Publish 0.19.50 before building the image; no image was built or deployed here. Its separately installed Claude/Pi vendor CLI graphs remain unaudited. Shim baseline had no lock; its new npm-generated lock pins pg 8.23.1 and Docker now uses npm ci. No production deployment/schema/secret changes are part of this task.

## Changes/checks

Final locks: bridge 0.19.50, ip-address 10.7.4, protobufjs 7.6.6 / @protobufjs/utf8 1.1.2; UI Next 15.5.28, sharp 0.35.5 / libvips 1.3.4 (native version 8.18.7), next-auth beta.32 / core 0.41.3, jose 6.2.13, oauth4webapi 3.8.8, PostCSS 8.5.31, nanoid 3.3.20, source-map-js 1.2.2, uuid 11.1.1, Vitest 4.1.12, Vite 8.1.6 and Undici 7.29.1. Direct manifest minima retain carets. Sharp is explicitly direct because Next also allows vulnerable 0.34.x.

Resolver evidence: npm 11.19.1 and isolated npm 12.2.0 retained Next's invalid nested PostCSS 8.4.31 with the scoped $postcss override; an existing-lock scoped literal also retained it. A fresh manifest-only npm11 literal resolved correctly but refreshed ~90 unrelated nodes, so that lock was rejected. Exact-parent next@15.5.28 override failed EOVERRIDE against direct ^15.5.28. Root approved global postcss:$postcss only after verifying every other parent (Tailwind and Vite) already resolved 8.5.31. Targeted npm update postcss then removed only the vulnerable nested node, updating the three approved CSS/ID packages; all parent package versions remained fixed. npm ls postcss --all exits 0. Never enable unsafe external source maps.

Security patch pins vitest.vite=8.1.6 and jsdom.undici=7.29.1 avoid unrelated latest minor upgrades; revisit when upstream parent minimums catch up. Ranges are compatible (Vitest supports Vite 6/7/8, jsdom Undici ^7.25.0). Required dev transitives: Rolldown 1.1.5/all platform optional bindings and OXC types 0.139.0, Chai 6.3.0, picomatch 4.0.7 and tinyrainbow 3.2.0. npm regenerated optional WASM layout: core 1.11.1 matches exact WASM binding, wasm-runtime 1.2.5 supports its 1.11.x runtime peers; duplicate nested core nodes removed. No new dev package names. Next/SWC and sharp/libvips optional binaries updated across supported platforms; sharp adds FreeBSD/WASM platform support. Auth's jose6/oauth4webapi3 majors were already present. No unreviewed runtime minor refresh was accepted.

All four final npm audits exit 0 with zero known vulnerabilities (bridge/UI/E2E/shim); raw JSON under /tmp/ftown-{bridge,ui,e2e,shim}-final-audit-2026-10-23.json. This is a point-in-time advisory check, not a claim about untested Docker/vendor graphs. Pure checks passed: IP valid IPv4/IPv6 subnet and zone handling plus adversarial invalid zone, protobuf Unicode round-trip and malformed EOF/binary rejection, Auth JWT round-trip/malformed bearer rejection, UUID v4 generation/validation, and actual sharp native PNG encode/decode. Package/lock engines and bridge 0.19.50 agree.

Heavy local suites/builds paused due root-measured sustained CPU saturation; Boat creation was rate-limited. Durable E2E CI now runs UI units/build, bridge build/units, release artifact tests and finite managed-Solo security smoke before full browser E2E (including new real login/session/signout regression). Separate deploy:false Centrifugo workflow performs real config/Fly checks. Root alone dispatches/monitors these; no worker E2E, server, Docker run/build, CI trigger or production write occurred. Runtime validation is pending, not claimed passed.

Fresh origin/main c194a6c still has bridge 0.19.49, so no 0.19.50 collision. It adds overlapping patched Node selectors and CA updates; integrate those commands rather than overwrite them. Four unrelated notes remain excluded from commits.

## Rollback

Each dependency group can be reverted with its manifest/lock/config commit, restoring the prior behavior and prior vulnerability. No data/schema migration or persisted format upgrade is introduced. A code revert does not revert an independently deployed runtime or managed hosting patch.
