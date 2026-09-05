# ftown Solo

Solo is a single-command, single-port way to run ftown on your own network,
with no account service and no cloud dependency:

```bash
npx ftown-bridge --solo
```

Your code, terminals, and agent output never leave your network. There is no
account, no cloud service, and no telemetry in Solo. The only outbound
traffic is two one-time downloads from GitHub (verified before use), plus
whatever AI agent CLIs you launch (Claude Code, pi, opencode, codex, kimi)
send to their own model providers — that's the agents' traffic, not ftown's.

## Privacy & data flow

| Component | Where it runs | What it talks to |
| --- | --- | --- |
| Panel (Next.js standalone) | Private loopback port, spawned by the bridge | Only the bridge's local API, over loopback |
| Centrifugo hub | Private loopback port, spawned by the bridge | Only the bridge, over loopback |
| Bridge local API | Loopback | Nothing external |
| Bridge front server | The **one** port you expose on your LAN | Your browser(s); proxies to the hub/panel/API above |
| Agent CLIs (Claude Code, pi, opencode, codex, kimi) | Spawned by the bridge as child processes | Their own model providers — not controlled by ftown |
| First run only | — | GitHub: Centrifugo binary + panel bundle (see below) |

Regular (non-Solo) ftown mints its identity from a cloud API
(`DEFAULT_API_URL = https://ftown.ia.br`, `bridge/src/index.ts:93`) and
persists a refresh token from it. Solo skips this entirely: when `--solo` is
set, the bridge mints its own hub JWT locally (`mintHubJwt`,
`bridge/src/solo/solo-auth.ts:112`) and connects to
`ws://127.0.0.1:<hubPort>/...` — there is no `fetchBridgeToken` call, no
`refreshBridgeToken` call, and no refresh-token file written
(`bridge/src/index.ts:398-429`).

The two one-time downloads:

1. **Centrifugo hub binary**, fetched from `github.com/centrifugal/centrifugo`
   releases and checked against a digest embedded in the bridge itself
   (`CENTRIFUGO_SHA256`, `bridge/src/solo/contract.ts:87`) — never fetched
   from a third-party checksum file.
2. **Panel bundle**, fetched from a GitHub release of this repository
   (`fmktech/ftown`) and verified against that release's own `.sha256`
   sidecar over HTTPS (`PANEL_BUNDLE_URL_TEMPLATE`,
   `bridge/src/solo/contract.ts:209`). It's cached at
   `<data-dir>/solo/panel/<version>/` so it's only downloaded once per bridge
   version (`bridge/src/solo/panel-manager.ts:121`).

The panel's Vercel Analytics script is compiled out of Solo builds
(`process.env.NEXT_PUBLIC_SOLO !== "1" && <Analytics />`,
`ui/src/app/layout.tsx:41`) — the script tag is never rendered, so nothing is
requested.

## Quick start

```bash
npx ftown-bridge --solo
```

This prints a banner with a URL like:

```text
http://192.168.1.10:8040/#k=<64-char-hex-key>
```

Open that URL on any device on the same Wi-Fi/LAN — your phone, another
laptop, anything. The key lives in the URL fragment (`#k=...`), which browsers
never send in a request — it's read client-side and exchanged for a session.
Bookmark or save the link; the browser keeps the key in local storage so you
don't need to re-enter it. Losing the link means re-running with
`--rotate-key` to get a fresh one.

## Docker

```bash
cd docker/solo
docker compose up -d --build
```

See [`docker/solo/README.md`](../docker/solo/README.md) and
[`docker/solo/compose.yml`](../docker/solo/compose.yml) for the full setup.
Key points:

- **Ports must match.** Publish the same host port as the container's
  `--port` (default `8040`). The bridge validates the browser's `Host` header
  against its own bound port (S19, `bridge/src/solo/solo-server.ts:266-291`);
  remapping ports (e.g. `-p 8068:8040`) makes `/api/solo/bootstrap` fail with
  `400 invalid host header` while `/healthz` still looks fine.
- **Volumes**: `/data` (`--data-dir`) holds session/event data;
  `/home/ftown/.ftown` holds the access-key hash, hub secret, and the
  downloaded hub/panel cache — losing it means a new key and a re-download.
- **Agent auth mounts**: mount `${HOME}/.pi/agent:/home/ftown/.pi/agent` to
  reuse host Pi credentials, and optionally `${HOME}/.claude:/home/ftown/.claude`
  for Claude Code OAuth credentials — or set `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` instead. `opencode` sessions aren't supported in the
  default image.

## Remote access (tunnels)

LAN traffic is plain HTTP by design (see Security notes). To reach Solo from
outside your LAN, put a TLS tunnel in front of the one exposed port instead
of exposing it directly:

- Tailscale `tailscale serve`
- `cloudflared tunnel`
- Any TLS-terminating reverse proxy/tunnel

Whatever you use, keep the tunnel's public port equal to whatever `--port`
the bridge is listening on, or set `--port` to match — same rule as Docker's
port mapping.

## Security notes

- **Plain HTTP on LAN**: anyone on the same network segment can capture your
  key off the wire. Use a tailnet or TLS tunnel if that's a concern.
- **Key handling**: the key is a 256-bit value (`ACCESS_KEY_BYTES = 32`,
  `bridge/src/solo/contract.ts:63`), generated with `crypto.randomBytes`.
  Only its SHA-256 hash is ever persisted (`bridge/src/solo/solo-auth.ts:15`);
  the raw key exists only in the banner and the URL fragment.
- `--rotate-key` regenerates the key offline and reprints the banner. It
  doesn't restart a running server process — restart the bridge (or the
  container) to make the running process pick up the new hash.
- No account service, no cloud identity, no telemetry.

## Troubleshooting

**Stuck on "Starting ftown Solo…"**
Check the bridge's terminal output for the actual error (hub/panel failing
to download or start). Confirm a panel release exists for your bridge
version — Solo downloads a GitHub release asset named
`ftown-ui-standalone-<version>.tar.gz` matching the bridge's own version.

**"Connection Failed" in the browser**
Requires bridge version ≥ 0.19.24. Earlier versions had WebSocket/identity
issues in Solo mode that are fixed as of that release.

**Sidebar shows "0 bridges"**
Same fix, same requirement: bridge version ≥ 0.19.24.

**Panel won't come back up after a container restart**
Stale pid files can wedge the panel/hub manager. Remove them and restart:

```bash
rm -f /data/solo/*.pid
docker restart ftown-solo
```

(`/data` is wherever `--data-dir` points; pid files live at
`<data-dir>/solo/hub.pid` and `<data-dir>/solo/panel.pid`.)

## Flags & env

| Flag / env | Meaning |
| --- | --- |
| `--solo` | Enable single-port LAN deployment mode |
| `--port <port>` | Public front port (default `8040`) |
| `--data-dir <path>` | Data directory (default `~/.ftown/data`) |
| `--rotate-key` | Regenerate the access key offline, print the new banner, exit |
| `FTOWN_SOLO_PANEL_VERSION` | Override which panel bundle version to fetch (defaults to the bridge's own version) |
| `FTOWN_SOLO_PANEL_DIR` | Use a local panel build directory instead of downloading one |

## Limitations

- The panel bundle is cached per bridge version at
  `<data-dir>/solo/panel/<version>/` — upgrading the bridge fetches a new
  panel build matching the new version.
- The `Host` header must equal the port the bridge is actually listening on;
  there's no flag to relax this, so port remaps (reverse proxies, Docker) must
  keep host and container ports identical, or pass a matching `--port`.
- In Docker, the startup banner prints the **container's** LAN IP (e.g.
  `172.17.0.2`), which isn't reachable from your browser — substitute the
  Docker host's real LAN IP (or `localhost` if browsing from the same
  machine) and keep the key from the banner.
