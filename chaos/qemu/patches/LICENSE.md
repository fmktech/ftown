# QEMU Patches Licensing

The files in this directory are derived from [QEMU](https://www.qemu.org), pinned to version `1:7.2+dfsg-7+deb12u18` (Debian bookworm source package `qemu=1:7.2+dfsg-7+deb12u18`, upstream QEMU 7.2) as specified in `chaos/qemu/qemu.Dockerfile`.

Because these files are derivative works of QEMU, they are licensed under the terms of the GNU General Public License, version 2 or (at your option) any later version (GPL-2.0-or-later):

`SPDX-License-Identifier: GPL-2.0-or-later`

For the upstream license terms, see the QEMU project website at [qemu.org](https://www.qemu.org) and its license terms at [COPYING](https://gitlab.com/qemu-project/qemu/-/blob/master/COPYING) (or [COPYING at v7.2.0](https://gitlab.com/qemu-project/qemu/-/blob/v7.2.0/COPYING)).

## QEMU Source Files Touched by Each Patch

- **`icount-warp-race.patch`** (`PATCH=1`, default): reads `icount_budget` under `vm_clock_lock` and skips a sleep=off warp while that budget is nonzero.
  - `softmmu/icount.c`
  - `accel/tcg/tcg-accel-ops-icount.c`
- **`tlb-deterministic-resize.patch`**:
  - `accel/tcg/cputlb.c`
- **`trace.py`**:
  - `util/qemu-timer.c`
  - `softmmu/icount.c`
  - `accel/tcg/tcg-accel-ops-icount.c`
  - `target/i386/tcg/sysemu/seg_helper.c`

## Binary Distribution and Corresponding Source

Any binary built with these patches must be distributed only together with its corresponding source (the pinned Debian source package `qemu=1:7.2+dfsg-7+deb12u18` plus these patches).

The test harness builds QEMU locally from source and does not ship a binary.
