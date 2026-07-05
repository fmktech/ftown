# ftown

A remote CLI agent orchestrator that lets you manage and stream **Claude Code** and **Cursor Agent** sessions through a web dashboard. Terminal streaming climbs a transport ladder — local loopback, then WebRTC P2P, then Centrifugo — so output stays on your machine or network whenever possible, and automatically upgrades back to a direct connection once it can. Recurring agent work runs as scheduled **loops**: cron or interval triggers that spawn full sessions with guardrails, instead of a hand-rolled polling script.

## Demo

### Desktop
https://github.com/user-attachments/assets/c077e4a6-1f25-4d60-b213-cd905c86c6a3

### Mobile
https://github.com/user-attachments/assets/e9c1ce70-70b0-4ba0-81d8-080d4eeef445



## Architecture

```
                        ┌─────────────┐
                   ┌────┤  Centrifugo  ├────┐
                   │    │  (pub/sub)   │    │
              WebSocket └─────────────┘ WebSocket
       (control · signaling · rung 3: cloud fallback)
                   │                     │
                   ▼                     ▼
            ┌─────────────┐       ┌─────────────┐
            │   Browser   │◄─────►│   Bridge    │
            │  (Next.js)  │       │ (node-pty)  │
            └─────────────┘       └─────────────┘
       rung 1: loopback WS — ws://127.0.0.1 (same machine)
       rung 2: WebRTC DataChannel — direct P2P (localhost / LAN)
     self-healing: browser keeps retrying rung 1 → 2 while on rung 3
```

- **UI** (`/ui`) — Next.js 15 web dashboard with real-time terminal streaming, climbing the transport ladder (local → P2P → Centrifugo) to reach the bridge
- **Bridge** (`/bridge`) — CLI tool that runs on remote machines, spawns processes via PTY, serves a loopback WebSocket for same-machine access, and relays I/O directly to the browser over WebRTC (or through Centrifugo when neither direct rung is possible)
- **Centrifugo** (`/centrifugo`) — WebSocket messaging server handling sessions, presence, and signaling, and serving as the last-resort (rung 3) data plane for terminal I/O

## Features

### Direct transport ladder

- Every session tries three rungs in order, falling through automatically: **Local** (loopback WebSocket, same machine, plain TCP so it survives VPNs/endpoint filters like Cloudflare WARP that block UDP/WebRTC) → **P2P** (WebRTC DataChannel over LAN/localhost, STUN only, no TURN) → **Cloud** (Centrifugo relay, the reliable fallback used only when both direct rungs fail)
- Live **Local / P2P / Cloud** badges in the terminal UI, each with a hoverable diagnostic tooltip explaining exactly why you're on that rung (e.g. "P2P unavailable — connection blocked (VPN or firewall may be interfering)")
- **Self-healing auto-upgrade**: while on Cloud, the browser keeps retrying the ladder in the background (backoff 15s → 30s → 60s → 120s with jitter, plus immediate retry on network-online / tab-visible events) and seamlessly flips a live session from Cloud to Local/P2P with a full screen resync — no reload
- Local-first, private transport: terminal output never touches the cloud while you're on the same machine or network; Centrifugo relays only while a remote viewer is actively watching
- Loopback WS is gated by a per-process random nonce plus Origin check; presence adverts are scoped to the owning user's JWT

### Loops

- First-class scheduled recurring agent runs — interval or cron+timezone — each firing a normal session with guardrails (preflight/postflight, max runtime, overlap/retention policy); see [Loops](#loops) below

### Everything else

- **Claude Code** and **Cursor Agent** (`agent`) interactive sessions with resume support
- Hook forwarding to the dashboard (Claude `~/.claude/settings.json`, Cursor `~/.cursor/hooks.json`)
- Multiple concurrent sessions with session management
- Multi-bridge support (connect multiple machines)
- Mobile-optimized responsive UI
- Authentication via NextAuth with rate-limited login
- Auto-refreshing bridge tokens (30-day refresh tokens)
- Connection diagnostics overlay for troubleshooting

## Loops

Loops replace fragile "keep an agent awake and polling" patterns with a durable scheduled primitive — cron for agents, with the full session UX (watch live, scroll back, take over) on every run.

Each loop is a schedule + harness + task prompt owned by the bridge; every fire spawns a normal ftown session, grouped under the loop in the dashboard.

```bash
ftown-sessions loop create \
  --cron "0 9 * * 1-5" --tz America/New_York \
  --harness claude --workdir ~/projects/ftown \
  --preflight "git fetch && git log origin/main..HEAD --oneline" \
  "Review overnight commits on main: {{preflight}}. Flag anything that needs attention."
```

- **Schedules** — interval (`--every 30s|5m|2h|1d`) or cron with timezone (`--cron "0 9 * * 1-5" --tz America/New_York`); create via the dashboard's loop modal or the CLI
- **Harness choice** — claude, cursor, codex, opencode, or plain shell, each with its own configurable workdir and model
- **Guardrails** — `--preflight <cmd>` (a non-zero exit skips the run; its stdout is injected into the prompt via `{{preflight}}`), `--postflight <cmd>` (receives run status, session id, and output), `--max-runtime` to force-stop a run
- **Overlap & retention** — overlapping runs are skipped by default (`--allow-overlap` to permit them); retention keeps only the newest N runs
- **Lifecycle** — pause/resume, fire a one-shot run manually, edit a loop live, and see run history with status dots (running/done/error/skipped/paused) plus next-due time in the dashboard

## Prerequisites

- Node.js 22+
- PostgreSQL database (e.g., [Neon](https://neon.tech))
- [Centrifugo](https://centrifugal.dev) v5 server
- On bridge machines: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and/or [Cursor CLI](https://cursor.com/docs/cli/overview) (`curl https://cursor.com/install -fsS | bash`, then `agent login`)

## Quick Start

### 1. Centrifugo

```bash
docker run -d --name centrifugo \
  -p 8000:8000 \
  -v $(pwd)/centrifugo/config.json:/centrifugo/config.json \
  centrifugo/centrifugo:v5
```

### 2. UI

```bash
cd ui
cp .env.local.example .env.local
# Edit .env.local with your Centrifugo secret, database URL, etc.
npm install
npm run dev
```

Create the database tables:

```sql
-- Run against your PostgreSQL database
\i schema.sql
```

### 3. Bridge

```bash
cd bridge
npm install
npm run build
```

Start a bridge by copying the CLI token command from the web UI (click "CLI Token"):

```bash
npx ftown-bridge --token <jwt> --api-url http://localhost:3000
```

On start, the bridge **auto-deploys** a local harness CLI:

- `~/.ftown/bin/ftown-harness` — list/tail/grep sessions, resolve workspace via `here`
- `~/.ftown/harness-agent.md` — agent cheat sheet (regenerated each start)
- `~/.ftown/bridge.json` — port + token while bridge is running

```bash
~/.ftown/bin/ftown-harness status
~/.ftown/bin/ftown-harness here -n 20
~/.ftown/bin/ftown-harness ls
```

## Configuration

### Environment Variables (UI)

| Variable | Description |
|----------|-------------|
| `CENTRIFUGO_TOKEN_SECRET` | Shared HMAC secret (must match Centrifugo config) |
| `NEXT_PUBLIC_CENTRIFUGO_URL` | WebSocket URL for Centrifugo |
| `AUTH_SECRET` | NextAuth.js secret (`npx auth secret`) |
| `DATABASE_URL` | PostgreSQL connection string |

### Centrifugo

Development config is at `centrifugo/config.json`. For production, create a `config.prod.json` (gitignored) with real secrets and TLS settings.

## Deployment

### Local Network

Run all three components on a single machine accessible to your LAN.

**1. Generate secrets:**

```bash
# Generate a strong HMAC secret for Centrifugo + UI
openssl rand -base64 64
# Generate an auth secret for NextAuth
npx auth secret
```

**2. Start PostgreSQL** (or use a hosted service like Neon):

```bash
docker run -d --name ftown-db \
  -p 5432:5432 \
  -e POSTGRES_USER=ftown \
  -e POSTGRES_PASSWORD=changeme \
  -e POSTGRES_DB=ftown \
  -v ftown-pgdata:/var/lib/postgresql/data \
  postgres:16

# Create tables
psql postgresql://ftown:changeme@localhost:5432/ftown -f ui/schema.sql
```

**3. Start Centrifugo:**

Edit `centrifugo/config.json` — replace `token_hmac_secret_key` and `api_key` with your generated secrets. Update `allowed_origins` to include your LAN IP:

```json
"allowed_origins": ["http://192.168.1.100:3000"]
```

```bash
docker run -d --name centrifugo \
  -p 8000:8000 \
  -v $(pwd)/centrifugo/config.json:/centrifugo/config.json \
  centrifugo/centrifugo:v5
```

**4. Start the UI:**

```bash
cd ui
cp .env.local.example .env.local
```

Edit `.env.local`:

```env
CENTRIFUGO_TOKEN_SECRET=<same secret as centrifugo config>
NEXT_PUBLIC_CENTRIFUGO_URL=ws://192.168.1.100:8000/connection/websocket
AUTH_SECRET=<your nextauth secret>
DATABASE_URL=postgresql://ftown:changeme@localhost:5432/ftown
```

```bash
npm install
npm run build
npm start  # Runs on port 3000
```

**5. Connect a bridge** from any machine on the LAN:

```bash
npx ftown-bridge --token <jwt> --api-url http://192.168.1.100:3000
```

Copy the token from the web UI at `http://192.168.1.100:3000` (click "CLI Token").

---

### AWS (Production)

This setup uses an EC2 instance for Centrifugo, Vercel for the UI, and Neon for the database. Adjust to your preferred stack.

#### Centrifugo on EC2

**1. Launch an EC2 instance** (t3.micro is sufficient):

- Amazon Linux 2023 or Ubuntu 22.04
- Security group: allow inbound TCP 80, 443 from `0.0.0.0/0`
- Attach an Elastic IP for a stable address

**2. Install Docker and start Centrifugo:**

```bash
sudo yum install -y docker  # Amazon Linux
sudo systemctl enable --now docker

# Create config directory
sudo mkdir -p /opt/centrifugo
```

**3. Create production config** at `/opt/centrifugo/config.json`:

```json
{
  "token_hmac_secret_key": "<your-secret>",
  "api_key": "<your-api-key>",
  "admin": false,
  "token_audience": "ftown:centrifugo",
  "allowed_origins": ["https://your-domain.vercel.app"],
  "allow_anonymous_connect_without_token": false,
  "allow_user_limited_channels": true,
  "allow_publish_for_subscriber": false,
  "allow_subscribe_for_client": false,
  "allow_history_for_subscriber": true,
  "presence": true,
  "join_leave": true,
  "force_push_join_leave": true,
  "allow_presence_for_subscriber": true,
  "history_size": 500,
  "history_ttl": "24h",
  "force_recovery": true,
  "namespaces": [
    {
      "name": "terminal",
      "allow_publish_for_subscriber": true,
      "allow_subscribe_for_client": true,
      "allow_user_limited_channels": true,
      "allow_history_for_subscriber": true,
      "history_size": 10000,
      "history_ttl": "24h",
      "force_recovery": true
    },
    {
      "name": "sessions",
      "allow_publish_for_subscriber": true,
      "allow_subscribe_for_client": true,
      "allow_user_limited_channels": true,
      "history_size": 0,
      "history_ttl": "0s",
      "force_recovery": false
    },
    {
      "name": "terminal-input",
      "allow_publish_for_subscriber": true,
      "allow_subscribe_for_client": true,
      "allow_user_limited_channels": true
    },
    {
      "name": "events",
      "allow_publish_for_subscriber": true,
      "allow_subscribe_for_client": true,
      "allow_user_limited_channels": true,
      "history_size": 100,
      "history_ttl": "1h"
    },
    {
      "name": "commands",
      "allow_publish_for_subscriber": true,
      "allow_subscribe_for_client": true,
      "allow_user_limited_channels": true
    },
    {
      "name": "bridges",
      "allow_publish_for_subscriber": true,
      "allow_subscribe_for_client": true,
      "allow_user_limited_channels": true,
      "presence": true,
      "join_leave": true,
      "force_push_join_leave": true,
      "allow_presence_for_subscriber": true
    }
  ],
  "tls_autocert": true,
  "tls_autocert_host_whitelist": "centrifugo.yourdomain.com",
  "tls_autocert_cache_dir": "/centrifugo/autocert",
  "tls_autocert_http": true,
  "tls_autocert_http_addr": ":80",
  "address": "0.0.0.0",
  "port": 443,
  "internal_port": 9000,
  "client_channel_limit": 256,
  "ping_interval": "10s",
  "pong_timeout": "5s",
  "log_level": "info"
}
```

**4. Run Centrifugo with TLS:**

```bash
sudo docker run -d --name centrifugo \
  --restart unless-stopped \
  -p 80:80 -p 443:443 \
  -v /opt/centrifugo/config.json:/centrifugo/config.json \
  -v /opt/centrifugo/autocert:/centrifugo/autocert \
  centrifugo/centrifugo:v5
```

**5. Point DNS** — Create an A record for `centrifugo.yourdomain.com` pointing to the Elastic IP. Centrifugo handles Let's Encrypt TLS automatically via `tls_autocert`.

#### UI on Vercel

**1. Push to GitHub** and import the repo in [Vercel](https://vercel.com).

**2. Set root directory** to `ui` in project settings.

**3. Add environment variables** in Vercel dashboard:

| Variable | Value |
|----------|-------|
| `CENTRIFUGO_TOKEN_SECRET` | Same secret as Centrifugo config |
| `NEXT_PUBLIC_CENTRIFUGO_URL` | `wss://centrifugo.yourdomain.com/connection/websocket` |
| `AUTH_SECRET` | Your NextAuth secret |
| `DATABASE_URL` | Your Neon connection string |

**4. Deploy.** Vercel auto-deploys on push to `main`.

#### Database on Neon

1. Create a project at [neon.tech](https://neon.tech)
2. Run `schema.sql` against the database (use the Neon SQL editor or `psql`)
3. Copy the connection string to Vercel env vars

#### Bridge

On any machine where you want to run Claude or Cursor Agent sessions:

```bash
npx ftown-bridge --token <jwt> --api-url https://your-domain.vercel.app
```

## Development

```bash
# Terminal 1: Centrifugo
docker run -p 8000:8000 -v $(pwd)/centrifugo/config.json:/centrifugo/config.json centrifugo/centrifugo:v5

# Terminal 2: UI
cd ui && npm run dev

# Terminal 3: Bridge
cd bridge && npm run dev -- --token <jwt> --api-url http://localhost:3000
```

## License

[MIT](LICENSE)
