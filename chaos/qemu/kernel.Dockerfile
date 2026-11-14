# Guest kernel: Debian bookworm cloud kernel, extracted for an x86_64 guest.
# Output stage contains /vmlinuz and /kernel-version.
FROM --platform=linux/amd64 debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS kernel
ARG KERNEL_PKG=linux-image-6.1.0-54-cloud-amd64
ARG KERNEL_VER=6.1.190-1
RUN apt-get update \
 && apt-get download "${KERNEL_PKG}=${KERNEL_VER}" \
 && dpkg-deb -x ./*.deb /k \
 && cp /k/boot/vmlinuz-* /vmlinuz \
 && ls /k/lib/modules > /kernel-version

FROM scratch
COPY --from=kernel /vmlinuz /kernel-version /
