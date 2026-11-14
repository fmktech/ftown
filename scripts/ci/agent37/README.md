# Agent37 CI template

The image in this directory is the Agent37 template (`ftown-ci`) that
`scripts/ci/agent37-runner.mjs` runs CI jobs on. It carries the toolchain the
e2e and unit jobs need: Node 24.22.1, Docker with Compose v2, git, and
Playwright's Chromium plus its OS dependencies, with an SSH server on port
22022 for the platform tunnel.

Build or rebuild it once per toolchain change (existing instances keep the old
revision until recreated):

```bash
a37 image build scripts/ci/agent37/Dockerfile ftown-ci scripts/ci/agent37
a37 update # for each long-lived CI instance, after a rebuild
```

The runner never builds the image and never creates an instance per job. It
reuses one long-lived, auto-sleeping instance per job kind (`ftown-ci-unit`
for the lightweight jobs, `ftown-ci-e2e-<shard>` per e2e shard), gives every
run its own remote directory under `~/ci/runs/`, and serializes runs on the
same instance with a remote `flock`. Instances are left running so the
platform's 300s auto-sleep can park them; they are never destroyed by CI.
