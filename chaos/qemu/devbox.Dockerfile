# Minimal x86_64 guest root used until ftown-chaos-box exists.
# Build context: the chaos/ directory.  docker build --platform linux/amd64 -f qemu/devbox.Dockerfile .
FROM --platform=linux/amd64 node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
RUN apt-get update \
 && apt-get install -y --no-install-recommends busybox-static \
 && rm -rf /var/lib/apt/lists/*
COPY . /opt/chaos
