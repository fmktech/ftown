# syntax=docker/dockerfile:1
# ftown chaos box: linux/amd64 root filesystem with a built ftown bridge that
# starts in solo mode with no network. Build context = repo root:
#   docker build --platform linux/amd64 -f chaos/box/Dockerfile -t ftown-chaos-box:dev .
# Base: node 24.22.1 (matches .nvmrc; satisfies bridge/package.json engines ^24.22.1).

ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

# ---------- bridge build (node-pty native build for linux/amd64) ----------
FROM --platform=linux/amd64 ${NODE_IMAGE} AS bridge
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/ftown/bridge
COPY bridge/package.json bridge/package-lock.json ./
RUN npm ci
COPY bridge/ ./
RUN npm run build && npm prune --omit=dev && npm cache clean --force \
    && node -e "require('node-pty')"

# ---------- pinned Centrifugo (digest from bridge/src/solo/contract.ts) ----------
FROM --platform=linux/amd64 ${NODE_IMAGE} AS hub
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY bridge/src/solo/contract.ts /tmp/contract.ts
RUN set -eu; \
    ver=$(sed -n "s/^export const CENTRIFUGO_VERSION = '\(v[^']*\)';/\1/p" /tmp/contract.ts); \
    sha=$(sed -n "s/^ *'linux-amd64': '\([0-9a-f]\{64\}\)',/\1/p" /tmp/contract.ts); \
    test -n "$ver" && test -n "$sha"; \
    curl -fsSL -o /tmp/hub.tgz "https://github.com/centrifugal/centrifugo/releases/download/${ver}/centrifugo_${ver#v}_linux_amd64.tar.gz"; \
    echo "${sha}  /tmp/hub.tgz" | sha256sum -c -; \
    mkdir -p /opt/chaos-seed/hub /tmp/x; tar -xzf /tmp/hub.tgz -C /tmp/x; \
    install -m 0755 /tmp/x/centrifugo "/opt/chaos-seed/hub/centrifugo-${ver}"; \
    printf '%s\n' "$sha" > "/opt/chaos-seed/hub/centrifugo-${ver}.sha256"

# ---------- the box ----------
FROM --platform=linux/amd64 ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux git zsh procps ca-certificates util-linux iproute2 kmod busybox-static \
    && rm -rf /var/lib/apt/lists/*
# uid 1000 is "node" in the base image; rename it to ftown.
RUN groupmod --new-name ftown node \
    && usermod --login ftown --home /home/ftown --move-home --shell /bin/zsh node \
    && touch /home/ftown/.zshrc && chown ftown:ftown /home/ftown/.zshrc
COPY --from=bridge /opt/ftown/bridge /opt/ftown/bridge
COPY --from=hub /opt/chaos-seed/hub /opt/chaos-seed/hub
COPY chaos/ /opt/chaos/
RUN mkdir -p /opt/chaos-bin /opt/chaos-seed/panel \
    && cp /opt/chaos/box/panel-stub/server.js /opt/chaos-seed/panel/server.js \
    && printf '#!/bin/sh\nexec node /opt/ftown/bridge/dist/ftown-cli.js "$@"\n' > /opt/chaos-bin/ftown \
    && chmod 0755 /opt/chaos-bin/ftown /opt/chaos/box/*.sh
# `ftown start` refuses to run until setup has completed for this version
# (bridge/src/setup-state.ts:37). Setup is local file writes only, so do it now.
USER ftown
ENV HOME=/home/ftown
RUN cd /home/ftown && node /opt/ftown/bridge/dist/ftown-cli.js setup
USER root
CMD ["/bin/sh"]
