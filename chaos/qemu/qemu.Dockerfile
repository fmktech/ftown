# QEMU runner for the host's native architecture. The guest is always x86_64.
# qemu-system-x86_64 is rebuilt from the pinned Debian source (minimal TCG-only x86_64 config);
# firmware and runtime libraries come from the pinned Debian package. Optional build args:
# TLBFIX=1 (default, required for reproducible runs) applies patches/tlb-deterministic-resize.patch:
# stock 7.2 sizes the softmmu TLB from host realtime, which leaks into guest PTE Accessed/Dirty bits.
# PATCH=1 (default) applies patches/icount-warp-race.patch: sleep=off must not advance
# the virtual clock across a halted vCPU slice that is not yet in qemu_icount.
# TRACE=1 adds investigation-only tracing (patches/trace.py), including a yield that
# widens the warp window. TRACE is never used for real runs.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS build
ARG QEMU_VER=1:7.2+dfsg-7+deb12u18
RUN sed -i 's/^Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends dpkg-dev ca-certificates build-essential python3 python3-venv \
      ninja-build meson pkg-config libglib2.0-dev libpixman-1-dev libfdt-dev zlib1g-dev patch flex bison \
 && cd /src 2>/dev/null || mkdir /src && cd /src \
 && apt-get source --only-source "qemu=${QEMU_VER}" \
 && rm -rf /var/lib/apt/lists/*
COPY patches/ /src/patches/
# PATCH=1 (default) closes the sleep=off idle warp race. TRACE=1 is investigation only.
ARG PATCH=1
ARG TLBFIX=1
ARG TRACE=0
RUN cd /src/qemu-7.2+dfsg \
 && if [ "$TLBFIX" = 1 ]; then patch -p1 --fuzz=0 < /src/patches/tlb-deterministic-resize.patch; fi \
 && if [ "$PATCH" = 1 ]; then patch -p1 --fuzz=0 < /src/patches/icount-warp-race.patch; fi \
 && if [ "$TRACE" = 1 ]; then python3 /src/patches/trace.py .; fi \
 && mkdir b && cd b \
 && ../configure --prefix=/usr --firmwarepath=/usr/share/qemu:/usr/share/seabios:/usr/lib/ipxe/qemu --target-list=x86_64-softmmu --disable-docs --disable-werror --disable-user \
      --disable-tools --disable-guest-agent --disable-slirp --disable-vnc --disable-sdl --disable-gtk \
      --disable-opengl --disable-curses --disable-spice --disable-libusb --disable-usb-redir \
      --disable-xen --disable-kvm --enable-tcg --without-default-features --enable-fdt=system \
 && ninja qemu-system-x86_64 \
 && strip qemu-system-x86_64 && cp qemu-system-x86_64 /qemu-system-x86_64

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
ARG QEMU_VER=1:7.2+dfsg-7+deb12u18+b3
# The Debian package provides firmware (SeaBIOS, option ROMs) and runtime libraries.
RUN apt-get update \
 && apt-get install -y --no-install-recommends "qemu-system-x86=${QEMU_VER}" cpio gzip \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /qemu-system-x86_64 /usr/bin/qemu-system-x86_64
ENTRYPOINT []
