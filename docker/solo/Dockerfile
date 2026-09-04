# ftown-bridge --solo, containerized.
#
# Facts this Dockerfile relies on (verified against bridge/src at HEAD):
#   - bridge/src/index.ts:124-131      CLI flags for --solo: --port <port>,
#                                       --data-dir <path>, --rotate-key, --token,
#                                       --api-url, --bridge-id. There is NO
#                                       --host/--bind flag.
#   - bridge/src/solo/contract.ts:35   DEFAULT_SOLO_PORT = 8040.
#   - bridge/src/solo/solo-server.ts:186,354
#                                       createSoloServer() calls
#                                       server.listen(config.port, options.host, ...).
#                                       `options.host` is an optional override used
#                                       only by tests to pin 127.0.0.1; index.ts's
#                                       real call site never passes `host`, so Node
#                                       listens with host=undefined, which binds
#                                       the wildcard address on all interfaces.
#                                       WILDCARD_ADDRESSES (solo-server.ts:199)
#                                       already includes '0.0.0.0'/'::'/''.
#                                       => No extra bind flag is needed here; the
#                                       default already listens on 0.0.0.0.
#   - bridge/src/index.ts:71-83        networkInterfacesForBanner() lists every
#                                       non-internal IPv4 address for the startup
#                                       banner. Inside a container that is the
#                                       container's own bridge-network IP (e.g.
#                                       172.17.0.2), NOT the Docker host's LAN IP.
#                                       Use http://<host-ip>:8040/#k=<key> instead
#                                       of whatever IP the banner prints. See README.
#   - bridge/src/solo/hub-manager.ts:35,90-102
#                                       resolvePlatformTriple() supports
#                                       darwin-arm64/amd64 and linux-amd64/arm64
#                                       only; linux/amd64 and linux/arm64 both work
#                                       here (throws UnsupportedPlatformError
#                                       otherwise).
#   - Sessions spawn external binaries:
#       bridge/src/tmux.ts                    execFileAsync/pty.spawn('tmux', ...)
#       bridge/src/claude-runner.ts:278        pty.spawn('tmux', ['attach-session', ...])
#       bridge/src/claude-runner.ts:356        pty.spawn('/bin/zsh', ['-l','-c', command])
#       bridge/src/harness-registry.ts:154     spawns 'opencode --auto'
#       bridge/src/harness-registry.ts:229     spawns 'claude --allow-dangerously-skip-permissions'
#       bridge/src/loop-scheduler.ts:122       spawn('/bin/sh', ['-c', command])
#     => tmux, zsh, and the `claude` CLI must be on PATH. `opencode` is NOT
#        installed by this image (not required by the task); Opencode-harness
#        sessions will fail to spawn until it is added — see README gotchas.

FROM node:22-bookworm-slim

# --- OS packages ---
# ca-certificates: TLS for npm installs and outbound HTTPS (hub archive, panel bundle, Claude API).
# tmux:            required by bridge/src/tmux.ts and claude-runner.ts (session multiplexing).
# git:             sessions frequently run git inside cloned repos under /workspace.
# zsh:             claude-runner.ts:356 spawns '/bin/zsh' for shell-type sessions.
# procps:          ps/kill etc. used by tmux/session bookkeeping and general debugging.
# tini:            correct PID 1 signal handling / zombie reaping (also available via `docker run --init`).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      tmux \
      git \
      zsh \
      procps \
      tini \
    && rm -rf /var/lib/apt/lists/*

# --- Non-root user ---
# Sessions spawn shells (tmux/zsh) as this user; uid 1000 matches the common
# first non-root uid on the Docker host so bind-mounted files land with a
# recognizable owner. node:22-bookworm-slim already ships a uid/gid 1000
# user+group named "node" (for the same reason) — rename it to "ftown"
# instead of fighting it for the id.
RUN groupmod --new-name ftown node \
    && usermod --login ftown --home /home/ftown --move-home --shell /usr/bin/zsh node

ENV HOME=/home/ftown

# --- Global npm packages ---
# ftown-bridge: pinned to 0.19.23 (published release with the Solo fixes).
# @anthropic-ai/claude-code: the `claude` CLI that harness-registry.ts:229 spawns
# for Claude Code sessions. Auth is NOT baked into the image — see README
# "Agent auth" for the two supported options (ANTHROPIC_API_KEY env var, or a
# mounted ~/.claude directory with existing OAuth credentials).
RUN npm install -g ftown-bridge@0.19.23 @anthropic-ai/claude-code \
    && npm cache clean --force

# --- Volumes ---
# /data              bridge --data-dir: session/event persistence.
# /home/ftown/.ftown loops.json, bridge.json, and the solo/ subdir (access-key-hash,
#                    hub-secret, downloaded hub binary + panel bundle cache).
# /workspace         where agent sessions do their work (bind-mount host projects here).
RUN mkdir -p /data /home/ftown/.ftown /workspace \
    && chown -R ftown:ftown /data /home/ftown/.ftown /workspace

VOLUME ["/data", "/home/ftown/.ftown", "/workspace"]

EXPOSE 8040

USER ftown
WORKDIR /workspace

# GOTCHA (verified empirically, see README "Port mapping — read this"):
# bridge/src/solo/solo-server.ts:272-291 isAllowedHost() rejects any request
# whose Host header port differs from the port the server itself is bound to
# (`split.port !== bound.port` at line 281) — there is no --host/--bind CLI
# flag to widen this. So `docker run -p <hostPort>:8040` with hostPort != 8040
# makes the browser's Host header (e.g. "192.168.1.5:8068") fail validation
# and /api/solo/bootstrap returns 400 "invalid host header", even though
# healthz is fine. The port is therefore a CMD default (not baked into
# ENTRYPOINT) so it can be overridden to match whatever host port you publish:
#   docker run -p 8040:8040 ftown-solo-test              # default, no override needed
#   docker run -p 8068:8068 ftown-solo-test --port 8068  # host port != 8040
ENTRYPOINT ["tini", "--", "ftown-bridge", "--solo", "--data-dir", "/data"]
CMD ["--port", "8040"]
