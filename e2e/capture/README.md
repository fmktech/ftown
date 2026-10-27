# Refresh product screenshots and walkthroughs

This opt-in capture runs the real local UI, bridge, PostgreSQL, Chromium and Codex CLI in a **disposable Linux sandbox**. It sends real requests to OpenAI, billed to the API account, and records a genuine coding task and follow-ups. The command creates a new test account and real sessions and approves a second browser. It records only after private approval is complete. The normal E2E suite does not discover this capture. Never use a personal machine, production database, existing services, personal Codex home or private workspace for it.

## Fresh Boat sandbox

From a reviewed, up-to-date checkout on the host, with an authenticated Boat CLI, create a sandbox using the existing account and a finite lifetime. The validated default image has Node 24.22.1 and Docker; verify these prerequisites if using another image. Replace `SANDBOX_ID` with the ID returned by `boat new` in every following command. The sandbox must be dedicated to this run; `boat push` copies tracked and non-ignored files, so inspect the source first for unwanted files and do not push credentials.

```sh
boat --no-update new --type default --ttl 7200 --no-env --no-snapshots --name ftown-product-capture
boat --no-update push SANDBOX_ID . --to /home/user/ftown
boat --no-update exec SANDBOX_ID -- sudo apt-get update
boat --no-update exec SANDBOX_ID -- sudo apt-get install -y zsh tmux libnss3-tools openssl ffmpeg iproute2
boat --no-update exec SANDBOX_ID -- sh -c 'if command -v codex >/dev/null; then [ "$(codex --version)" = "codex-cli 0.164.0" ] || { echo "Resolve the existing Codex version before capture" >&2; exit 1; }; else sudo npm install -g @openai/codex@0.164.0; fi'
boat --no-update exec SANDBOX_ID --cwd /home/user/ftown/e2e -- npm ci
boat --no-update exec SANDBOX_ID --cwd /home/user/ftown/e2e -- npx playwright install-deps chromium
boat --no-update exec SANDBOX_ID -- sudo hostnamectl set-hostname demo-workstation
boat --no-update exec SANDBOX_ID -- hostname
```

The install-deps step installs Chromium OS libraries and may use sudo; it is deliberately outside the capture wrapper. The wrapper itself does not install OS packages. Verify the final `hostname` command prints `demo-workstation` after installation. The wrapper requires Node 24.22.1 or newer within major version 24, npm/npx, Docker Compose with an accessible default local Docker socket, zsh, tmux, certutil, openssl, ffmpeg, ffprobe, `ss` (from iproute2), and genuine Codex CLI 0.164.0 on PATH. The command above reuses the exact version when present and installs it only when `codex` is absent. If another version or a name collision exists, resolve it through the installation manager that owns it; do not force an overwrite. Use the same prerequisites on any other disposable Linux host. The actual OS hostname must be `demo-workstation`, and the canonical checkout must be `/home/user/ftown`.

Provision an OpenAI API key through a private channel into a new sandbox-owned regular file outside the checkout and staging, for example `/home/user/ftown-capture-openai-key`. Set the file mode to 0600 and ensure it is owned by the sandbox user. Do not place the key in a command line, shell history, environment, checkout or output directory. The key must have access to `gpt-6.1-terra`; the scratch Codex configuration selects `xhigh` reasoning. The wrapper rejects inherited provider credentials and Codex/provider selectors. It passes the key to `codex login --with-api-key` on stdin in the disposable bridge home. The operator owns and must delete the external key file after the run; the wrapper never removes the input file.

Run from the sandbox checkout, with no inherited deployment/database/service/Docker selectors or live `.env` files:

```sh
env -u CODEX_PATH -u CLAUDE_PATH FTOWN_CAPTURE_ISOLATED=1 FTOWN_CAPTURE_DIR=/tmp/ftown-product-media FTOWN_CAPTURE_OPENAI_KEY_FILE=/home/user/ftown-capture-openai-key bash e2e/capture/run.sh
```

For example, through Boat:

```sh
boat --no-update exec SANDBOX_ID --cwd /home/user/ftown --timeout 3600 -- env -u CODEX_PATH -u CLAUDE_PATH FTOWN_CAPTURE_ISOLATED=1 FTOWN_CAPTURE_DIR=/tmp/ftown-product-media FTOWN_CAPTURE_OPENAI_KEY_FILE=/home/user/ftown-capture-openai-key bash e2e/capture/run.sh
```

The output path must be absolute, canonical, outside the checkout and empty or new, with an existing canonical parent. Existing output is never removed. Each run requires a fresh empty path. Preflight rejects existing containers, matching Compose project resources, scratch homes, PID records, generated certs, service logs, active environment files, inherited selectors, or occupied ports 443, 5432, 8000, 3000, 8080, 8443 and 8444 before schema creation. It uses a run-specific Compose project, validates the local selectors, installs dependencies and Chromium, creates local certificates and browser trust, builds and starts the stack, then runs the single-worker capture. It tears down its exact services and Compose project even on failure. A cleanup error makes the command fail and preserves the run marker for inspection; the primary error is retained. Staging is retained for review, including on failure. Resolve any remaining owned resources before retrying; never delete other workloads to make preflight pass.

## Review and publish

A successful staging directory contains raw `desktop.png`, `mobile.png`, `security.png`, seven responsive `.webp` files, `desktop-workspace.mp4`, `mobile-terminal.mp4`, `manifest.json`, and private recording frames/metadata. The version 2 manifest identifies each public file and its measured dimensions, bytes and video duration. The silent MP4s show an actual Codex session and two real follow-up responses; provider response time varies and a timeout or authentication failure fails capture without a fabricated fallback. The fixture and scratch bridge home are removed during cleanup. Review all images and both videos for legibility, genuine UI state, privacy and correct dimensions/duration before publication. Do not publish raw PNGs, frame directories, logs, approval links/codes, or other staging material.

Copy staging to a private local review directory before deleting the sandbox, for example:

```sh
boat --no-update scp -r SANDBOX_ID:/tmp/ftown-product-media /tmp/ftown-product-media-review
```

After review, copy **only** the seven manifest-referenced WebPs, two manifest-referenced MP4s and the manifest to `ui/public/product/`. Check that every referenced filename is present and that the manifest contains no private data; do not blindly copy the staging directory. Commit the approved files and open a PR. For the next periodic refresh, start from the latest checkout with the previous genuine assets committed, create a new disposable sandbox and empty output path, run the same command, review, and publish only this whitelist. No scheduled or automatic publication is configured.

During the initial v2 migration only, use the previously approved v1 UI source and v1 manifest in the capture checkout before syncing the v2 presentation: the wrapper rebuilds the UI, so a previously built v1 output alone is insufficient. This avoids creating placeholder assets to bootstrap the build. Later runs build from the committed genuine v2 media.

After the run, securely remove the task-owned external key file through the private provisioning workflow. Finally delete only this task’s sandbox and verify it is gone, whether capture succeeded or failed:

```sh
boat --no-update delete SANDBOX_ID --yes
boat --no-update info SANDBOX_ID
boat --no-update list
```

Confirm `info` reports the sandbox absent and it no longer appears in `list`; investigate any asynchronous deletion still in progress. The sandbox contains test accounts and private staging even if capture failed. Do not publish its contents without review.
