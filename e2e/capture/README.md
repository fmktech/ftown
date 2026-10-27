# Refresh product screenshots and walkthroughs

This opt-in capture runs the real local UI, bridge, PostgreSQL, Chromium and terminal in a **disposable Linux sandbox**. The command creates a new test account and real sessions and approves a second browser. It records only after private approval is complete. The normal E2E suite does not discover this capture. Never use a personal machine, production database, existing services, account credentials or private workspace for it.

## Fresh Boat sandbox

From a reviewed, up-to-date checkout on the host, with an authenticated Boat CLI, create a sandbox using the existing account and a finite lifetime. The validated default image has Node 24.22.1 and Docker; verify these prerequisites if using another image. Replace `SANDBOX_ID` with the ID returned by `boat new` in every following command. The sandbox must be dedicated to this run; `boat push` copies tracked and non-ignored files, so inspect the source first for unwanted files and do not push credentials.

```sh
boat --no-update new --type default --ttl 7200 --no-env --no-snapshots --name ftown-product-capture
boat --no-update push SANDBOX_ID . --to /home/user/ftown
boat --no-update exec SANDBOX_ID -- sudo hostname demo-workstation
boat --no-update exec SANDBOX_ID -- sudo apt-get update
boat --no-update exec SANDBOX_ID -- sudo apt-get install -y zsh tmux libnss3-tools openssl ffmpeg iproute2
boat --no-update exec SANDBOX_ID --cwd /home/user/ftown/e2e -- npm ci
boat --no-update exec SANDBOX_ID --cwd /home/user/ftown/e2e -- npx playwright install-deps chromium
```

The install-deps step installs Chromium OS libraries and may use sudo; it is deliberately outside the capture wrapper. The wrapper itself does not install OS packages. It requires Node 24.22.1 or newer within major version 24, npm/npx, Docker Compose with an accessible default local Docker socket, zsh, tmux, certutil, openssl, ffmpeg, ffprobe and `ss` (from iproute2). Use the same prerequisites on any other disposable Linux host. The actual OS hostname must be `demo-workstation`, and the canonical checkout must be `/home/user/ftown`. The supplied test command uses that exact path and needs no `.git` directory or paid provider.

Run from the sandbox checkout, with no inherited deployment/database/service/Docker selectors or live `.env` files:

```sh
FTOWN_CAPTURE_ISOLATED=1 FTOWN_CAPTURE_DIR=/tmp/ftown-product-media bash e2e/capture/run.sh
```

For example, through Boat:

```sh
boat --no-update exec SANDBOX_ID --cwd /home/user/ftown --timeout 3600 -- env FTOWN_CAPTURE_ISOLATED=1 FTOWN_CAPTURE_DIR=/tmp/ftown-product-media bash e2e/capture/run.sh
```

The output path must be absolute, canonical, outside the checkout and empty or new, with an existing canonical parent. Existing output is never removed. Each run requires a fresh empty path. Preflight rejects existing containers, matching Compose project resources, scratch homes, PID records, generated certs, service logs, active environment files, inherited selectors, or occupied ports 443, 5432, 8000, 3000, 8080, 8443 and 8444 before schema creation. It uses a run-specific Compose project, validates the local selectors, installs dependencies and Chromium, creates local certificates and browser trust, builds and starts the stack, then runs the single-worker capture. It tears down its exact services and Compose project even on failure. A cleanup error makes the command fail and preserves the run marker for inspection; the primary error is retained. Staging is retained for review, including on failure. Resolve any remaining owned resources before retrying; never delete other workloads to make preflight pass.

## Review and publish

A successful staging directory contains raw `desktop.png`, `mobile.png`, `security.png`, seven responsive `.webp` files, `desktop-workspace.mp4`, `mobile-terminal.mp4`, `manifest.json`, and private recording frames/metadata. The version 2 manifest identifies each public file and its measured dimensions, bytes and video duration. The MP4s are silent real interactions and terminal output. Review all images and both videos for legibility, genuine UI state, privacy and correct dimensions/duration before publication. Do not publish raw PNGs, frame directories, logs, approval links/codes, or other staging material.

Copy staging to a private local review directory before deleting the sandbox, for example:

```sh
boat --no-update scp -r SANDBOX_ID:/tmp/ftown-product-media /tmp/ftown-product-media-review
```

After review, copy **only** the seven manifest-referenced WebPs, two manifest-referenced MP4s and the manifest to `ui/public/product/`. Check that every referenced filename is present and that the manifest contains no private data; do not blindly copy the staging directory. Commit the approved files and open a PR. For the next periodic refresh, start from the latest checkout with the previous genuine assets committed, create a new disposable sandbox and empty output path, run the same command, review, and publish only this whitelist. No scheduled or automatic publication is configured.

During the initial v2 migration only, use the previously approved v1 UI source and v1 manifest in the capture checkout before syncing the v2 presentation: the wrapper rebuilds the UI, so a previously built v1 output alone is insufficient. This avoids creating placeholder assets to bootstrap the build. Later runs build from the committed genuine v2 media.

Finally delete only this task’s sandbox and verify it is gone, whether capture succeeded or failed:

```sh
boat --no-update delete SANDBOX_ID --yes
boat --no-update info SANDBOX_ID
boat --no-update list
```

Confirm `info` reports the sandbox absent and it no longer appears in `list`; investigate any asynchronous deletion still in progress. The sandbox contains test accounts and private staging even if capture failed. Do not publish its contents without review.
