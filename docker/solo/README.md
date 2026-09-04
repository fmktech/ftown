# ftown-bridge --solo in Docker

Runs `ftown-bridge --solo` (single-port LAN deployment) inside a container.

## Port mapping — read this

**Publish the host port with the same number as the container port**, or
override `--port` to match whatever host port you publish. The bridge
validates the browser's `Host` header against its own bound port
(`bridge/src/solo/solo-server.ts:272-291`, `isAllowedHost()`) and there is no
`--host`/`--bind`/allowlist flag exposed on the CLI to relax this. If you
remap the port (e.g. `-p 8068:8040`), every request to
`/api/solo/bootstrap` fails with `400 invalid host header` even though
`/healthz` looks fine — the page gets stuck on "Starting ftown Solo…" forever.

Two ways to run on a non-default port:

```bash
# same port on both sides — works with the image's default
docker run -p 8068:8068 ... ftown-solo --port 8068

# default 8040 on both sides
docker run -p 8040:8040 ... ftown-solo
```

`--port` is the image's `CMD` (not baked into `ENTRYPOINT`), so it's a plain
trailing argument on `docker run`.

## Build & run

```bash
cd docker/solo
docker compose up -d --build
```

or with plain Docker:

```bash
docker build -t ftown-solo .
mkdir -p ./workspace
docker run -d --init --name ftown-solo \
  -p 8040:8040 \
  -v ftown-solo-data:/data \
  -v ftown-solo-home:/home/ftown/.ftown \
  -v "$(pwd)/workspace:/workspace" \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  ftown-solo
```

## Finding the access key / link

On first start the bridge prints a banner with the access key and a
ready-to-use URL. Read it from the container logs:

```bash
docker logs ftown-solo
```

**Important:** the banner's URL uses the *container's* own LAN IP (from
`networkInterfacesForBanner()` in `bridge/src/index.ts`), e.g.
`http://172.17.0.2:8040/#k=<key>` — that address is only reachable from
inside the Docker network, not from your browser. Instead, open:

```
http://<docker-host-ip>:8040/#k=<key>
```

using the Docker host's real LAN IP (or `localhost`/`127.0.0.1` if browsing
from the same machine) and the key from the banner.

## Persistence

- `/data` — session/event data (`--data-dir`), backed by the `ftown-solo-data` volume.
- `/home/ftown/.ftown` — `loops.json`, `bridge.json`, the access-key hash, hub
  secret, and the downloaded Centrifugo hub binary + panel bundle cache,
  backed by the `ftown-solo-home` volume. Losing this volume loses the access
  key (a new one is generated) and forces a re-download of the hub/panel on
  next start.
- `/workspace` — bind-mounted from the host (`FTOWN_WORKSPACE`, default
  `./workspace`) so session shells/agents operate on real host files.

## Agent auth

Sessions that spawn the `claude` CLI (`bridge/src/harness-registry.ts:229`)
need Anthropic credentials. Two options:

1. **Env var** — set `ANTHROPIC_API_KEY` (compose passes it through; `docker
   run -e ANTHROPIC_API_KEY=...`).
2. **Mounted credentials** — bind-mount an existing `~/.claude` (with valid
   OAuth credentials from a `claude login` done elsewhere) to
   `/home/ftown/.claude` in the container instead of/alongside the env var.

`opencode` sessions (`bridge/src/harness-registry.ts:154`) are **not**
supported by this image — the `opencode` binary isn't installed. Add it to
the Dockerfile if you need Opencode-harness sessions.

## Rotating the access key

```bash
docker exec ftown-solo ftown-bridge --solo --rotate-key --data-dir /data
```

This regenerates the key offline and prints the new banner; it does not
restart the running server process, so also restart the container
(`docker restart ftown-solo`) if you want the running process's
in-memory key check to pick up the new hash immediately.
