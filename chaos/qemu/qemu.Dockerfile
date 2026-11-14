# QEMU runner for the host's native architecture. The guest is always x86_64.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
ARG QEMU_VER=1:7.2+dfsg-7+deb12u18+b3
RUN apt-get update \
 && apt-get install -y --no-install-recommends "qemu-system-x86=${QEMU_VER}" \
 && rm -rf /var/lib/apt/lists/*
# Builds the initramfs too: cpio + gzip are needed for that.
RUN apt-get update && apt-get install -y --no-install-recommends cpio gzip && rm -rf /var/lib/apt/lists/*
ENTRYPOINT []
