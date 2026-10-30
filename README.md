# ftown

A remote CLI agent orchestrator that lets you manage and stream **Claude Code, Cursor Agent, Codex, Grok, Muse Code, Pi, Kimi Code, opencode,** and shell sessions through a web dashboard. Terminal streaming climbs a transport ladder — local loopback, then WebRTC P2P, then Centrifugo — so output stays on your machine or network whenever possible, and automatically upgrades back to a direct connection once it can. The FTown MCP gateway lets connected assistants inspect and control sessions across your authorized computers and follow durable requests for human input.

## Demo

### Desktop
https://github.com/user-attachments/assets/c077e4a6-1f25-4d60-b213-cd905c86c6a3

### Mobile
https://github.com/user-attachments/assets/e9c1ce70-70b0-4ba0-81d8-080d4eeef445



## Architecture

```mermaid
flowchart TB
  Browser["Browser / PWA<br/>Separate non-extractable HPKE + ECDSA keys<br/>Pinned signed account history"]
  Relay["Centrifugo relay<br/>Opaque application content<br/>Visible routing metadata"]
  Bridge["Bridge: trusted plaintext endpoint<br/>Local identity + approved-device policy<br/>Sessions, terminal history and mail"]
  Client["AI / MCP client + its provider"]
  Gateway["Hosted MCP: trusted plaintext endpoint<br/>Distinct encrypted grant identity"]
  Database["PostgreSQL<br/>Encrypted MCP private keys + bound pins<br/>Account, OAuth and audit records"]
  Secret["Separately provisioned service wrapping secret"]
  Account["Account login / OAuth consent<br/>Pending requests + signed public roster<br/>Service orders and delivers updates"]
  Push["Push provider<br/>Generic notice + opaque routing references"]
  Agent["Local agents, tools and files"]
  Provider["External model providers"]
  Browser <-->|"HPKE Auth application encryption"| Relay
  Relay <-->|"HPKE Auth application encryption"| Bridge
  Browser <-->|"Same application encryption over local HTTP/WS or WebRTC"| Bridge
  Client <-->|"HTTPS + OAuth: gateway sees tool calls/results"| Gateway
  Gateway <-->|"HPKE Auth application encryption"| Bridge
  Gateway <-->|"Authenticated ciphertext for private keys"| Database
  Secret -->|"AES-256-GCM wrapping; not stored in DB"| Gateway
  Browser <-->|"HTTPS: account/approval/consent metadata"| Account
  Bridge <-->|"HTTPS: pending requests + signed public history"| Account
  Bridge -->|"Generic notification only"| Push
  Push --> Browser
  Bridge <-->|"Decrypted local dispatch; local hooks are plaintext"| Agent
  Agent <-->|"Provider's own protocol/trust boundary"| Provider
```

- **UI** (`/ui`) — Next.js 15 web dashboard with real-time terminal streaming, climbing the transport ladder (local → P2P → Centrifugo) to reach the bridge
- **Bridge** (`/bridge`) — CLI tool that runs on remote machines, spawns processes via PTY, serves a loopback WebSocket for same-machine access, and relays I/O directly to the browser over WebRTC (or through Centrifugo when neither direct rung is possible)
- **Centrifugo** (`/centrifugo`) — WebSocket messaging server handling sessions, presence, and signaling, and serving as the last-resort (rung 3) data plane for terminal I/O

## Encryption and device trust

Application content is encrypted between approved Browser/PWA, bridge, and MCP
gateway endpoints using HPKE Auth (P-256, HKDF-SHA256, AES-256-GCM). Commands,
terminal I/O and history, session names and paths, mail, prompts/results,
attention text, PR details, and WebRTC SDP/ICE use authenticated encryption on
every transport. Direct transport failure can select another encrypted route;
it cannot enable plaintext fallback. Older clients and bridges require upgrade
and explicit pairing.

On an account with an approved device, normal onboarding needs no copied link:

1. Sign in on a new browser or phone. It creates one request and shows **Waiting
   for approval**. For a new computer, start the bridge with
   `ftown start --account you@example.com`; the email routes its request and
   grants no access.
2. On an approved browser, open **Security → Devices → Pending approvals** and
   choose **Review** for the device you recognize. Review alone grants no access.
3. Compare the verification code displayed on both actual devices. Confirm the
   match locally on each, then approve in the trusted browser. Only verified
   approval enables encrypted access. A browser approval covers all current and
   future account computers; each new computer is approved once.

Reject an unexpected request. If the codes differ, cancel and begin a fresh
attempt; do not keep approving until one works. A bridge can show its local code
with `ftown security pair-status`; use `ftown security pair-confirm <code>` on
that computer to confirm it, or `ftown security pair-reject` to cancel.
Background services log instructions rather than codes or private links.

The very first account device still needs explicit bootstrap: start the first
computer with `ftown start --bootstrap`, open its private `/pair` link and compare
the code. That confirmation enrolls the first browser and computer together.
**Use a private approval link** remains an explicit browser fallback; an
established account still requires an approved browser to confirm it. Retrieve a
background bootstrap link explicitly with `ftown security pair-link`. Fragment
secrets stay in the browser tab, never ordinary query parameters or operational
logs. Automatic approval never silently switches to this fallback.

Requests expire after five minutes. Browser reload resumes the same saved
request and verification state; a lost reply retries the exact committed
operation without adding membership twice. Expired delivery may require reopening
the trusted approval view while the request is still valid. Rejection, mismatch,
expiry, competing history, or loss of the temporary verification state requires
an explicit fresh attempt while preserving long-term device keys. A bridge
process restart loses that temporary state; it cannot silently reuse the old
comparison with a new secret.

Each browser installation stores separate non-extractable HPKE encryption and
ECDSA signing private keys in IndexedDB. Only an approved browser signs account
device membership; a bridge's encryption key cannot approve other devices.
A signed account roster and pinned
history establish device/computer trust; an unsigned directory cannot grant
access or replace a known root. The service still orders and delivers history.
Connected computers refresh every 30 seconds, with account access paused after
24 hours without a valid authenticated refresh. This connectivity allowance is
not a guaranteed revocation deadline against a service withholding updates.
Clearing site storage requires new device approval. Browser storage does not
promise hardware protection or an encrypted browser profile; password resets
cannot recover lost signing keys.

Existing bridge approvals remain independent until an administrator chooses
**Security → Devices → Use account device approvals** for that computer. Adoption
replaces its legacy browser grants and outstanding invitations, preserving local
CLI recovery and existing MCP grants. Solo remains independent. A local
`ftown security invite` recovery link accesses one computer; it cannot reset or
sign account trust. Losing every account signing key requires explicit recovery
of each existing computer, with no automatic root reset.

The hosted `/dashboard` uses account trust on every transport, including local
HTTP, loopback WebSocket, and WebRTC. The standalone `/local` page remains the
independent per-bridge legacy/local-recovery mode; it does not enroll account
devices or replace account approvals. Each new browser process must refresh its
pinned account history successfully before using account-derived access. During
that process, later outages allow at most 24 hours from the last valid read,
checked against both wall-clock highwaters and elapsed monotonic time.

The hosted MCP gateway is a trusted plaintext endpoint for standard HTTPS/OAuth
clients. Each OAuth grant gets a distinct bridge-facing identity, approved by
an administrator browser for selected bridges and read/control scopes. Its
private key and bridge pins are authenticated ciphertext in PostgreSQL, wrapped
with a separate service secret. Standard MCP clients need no model PIN. Local
agents and external model providers remain separate trusted endpoints.

Open **Security → Devices** to inspect the account roster and revoke a device
across account computers. The last account administrator cannot be revoked;
approve another device first. **Security → Activity** shows retained MCP gateway attempts
and independent bridge execution records. Gateway history remains available
while a bridge is offline. An unknown outcome or timeout does not prove that
an operation was not executed. Logs retain up to 30 days and 10,000 events per
store; raw arguments, results, commands and tokens are excluded.

Routing metadata remains visible: account/bridge/session identifiers, hostname,
online state, endpoint keys, sizes and timing. Login, OAuth consent, public-key
directory and device metadata use HTTPS. Push notifications contain only a
generic notice and opaque routing references. Minimal health/discovery and
local hook ingestion are explicit plaintext exceptions. The bridge decrypts
before dispatching local tools; this protocol does not encrypt their files or
replace their provider security. Endpoint software and same-origin browser code
remain trusted. No anonymity, forward secrecy, hardware-backed key protection,
or zero-knowledge hosted MCP is claimed. See [operational setup](docs/e2ee-operations.md).

Automatic approval uses FTown's committed verification-code protocol over HPKE;
it is not externally audited or compatible with another messenger's pairing
protocol. Its code comparison gives approximately 48-bit protection per attempt
when users check both devices. A matching code alone, login, or a server-reported
approved status cannot unlock access. This comparison does not inherit the
256-bit out-of-band assurance of the explicit private-link fallback.

## Features

### Solo mode — runs entirely on your network

```bash
npx ftown setup
npx ftown start --solo
```

Your code, terminals and agent output never leave your network. ftown Solo has no account, no cloud service and no telemetry; the only outbound traffic is two one-time downloads from GitHub, plus whatever your AI agents themselves send to their model providers.

Prints a local access link. Open it on trustworthy localhost, or configure an HTTPS tunnel for another device on your Wi-Fi before connecting; plain LAN HTTP cannot enable encrypted controls. No Centrifugo to install (a checksum-pinned hub binary is downloaded and managed for you), no UI hosting (the panel bundle is fetched from a GitHub release on first run), no account service.

- **Single port**: panel + bridge API + websocket hub behind one listener; the hub and panel themselves only bind loopback. Tunnels (Tailscale serve, cloudflared, ngrok) just point at the one port when you want off-LAN access
- **No telemetry**: panel analytics are compiled out of Solo builds — no script is ever requested
- **Key auth**: 256-bit key lives in the URL fragment (never sent to a server in a request path/query); only its SHA-256 hash is persisted; `--rotate-key` regenerates it offline; `--port` overrides the default (`8040`)
- **Secure browser context required**: encrypted controls require HTTPS or trustworthy localhost. Put LAN access behind a TLS tunnel; plain `http://<LAN-IP>` shows setup guidance and never enables plaintext controls. Protect the Solo access credential with TLS as well.
- **Docker**: `cd docker/solo && docker compose up -d --build` — see [`docker/solo/README.md`](docker/solo/README.md)

Full guide: [docs/solo.md](docs/solo.md)

### Direct transport ladder

- Every session tries three rungs in order, falling through automatically: **Local** (loopback WebSocket, same machine, plain TCP so it survives VPNs/endpoint filters like Cloudflare WARP that block UDP/WebRTC) → **P2P** (WebRTC DataChannel over LAN/localhost, STUN only, no TURN) → **Cloud** (Centrifugo relay, the reliable fallback used only when both direct rungs fail)
- Live **Local / P2P / Cloud** badges in the terminal UI, each with a hoverable diagnostic tooltip explaining exactly why you're on that rung (e.g. "P2P unavailable — connection blocked (VPN or firewall may be interfering)")
- **Self-healing auto-upgrade**: while on Cloud, the browser keeps retrying the ladder in the background (backoff 15s → 30s → 60s → 120s with jitter, plus immediate retry on network-online / tab-visible events) and seamlessly flips a live session from Cloud to Local/P2P with a full screen resync — no reload
- Local-first, private transport: terminal output never touches the cloud while you're on the same machine or network; Centrifugo relays only while a remote viewer is actively watching
- Loopback WS requires an approved HPKE endpoint and authenticated pair binding, with Origin/Host checks retained; localPort is discovery metadata only, and presence adverts are scoped to the owning user's JWT

### Live HTML previews

Agents can put an interactive explanation, mockup, or diagram beside their terminal:

```bash
ftown sessions preview ./design.html
```

The dashboard opens a resizable preview on the right and refreshes it when the file changes. On mobile and narrow layouts, Terminal and Preview are tabs. Closing the pane keeps the registration; `ftown sessions preview --clear` removes it. Use `--session-id <id>` outside the target session.

Previews are self-contained UTF-8 HTML files inside the session's working directory, up to 1 MiB. Inline CSS, JavaScript, and embedded data images are supported; sibling files, external assets, and backend requests are not. Publish completed edits with a temporary file and atomic rename. Each changed document reloads and resets its interactive state.

The file travels through the existing encrypted connection and runs in an iframe without dashboard-origin access. There is no preview-to-terminal messaging channel. See the [preview guide](docs/session-html-preview/usage.md) for authoring, limitations, and troubleshooting.

### Everything else

- Eight coding-agent CLIs plus raw shells as full interactive sessions
- Parent/child agent trees, durable cross-session mail, and session reparenting
- Native resume support for Claude, Cursor, Codex, and Pi; workdir-based continuation for Kimi Code
- Live per-session token/model usage for harnesses with structured native session logs
- Hook forwarding to the dashboard (Claude/Codex settings, Cursor hooks, and ftown's bundled Pi extension)
- Native Pi tools for session discovery/control, durable ftown mail, token usage, terminal inspection, and archives
- Optional [Web Push notifications](docs/push-notifications.md) for agent questions and the first observed idle transition per agent on hosted deployments
- Multiple concurrent sessions with session management
- Multi-bridge support (connect multiple machines)
- Mobile-optimized responsive UI
- Authentication via NextAuth with rate-limited login
- Auto-refreshing bridge tokens (30-day refresh tokens)
- Connection diagnostics overlay for troubleshooting

## Prerequisites

- Node.js 22+
- PostgreSQL database (e.g., [Neon](https://neon.tech))
- [Centrifugo](https://centrifugal.dev) v5 server
- On bridge machines: install and authenticate whichever agent CLIs you plan to run. For Pi: `npm install -g @mariozechner/pi-coding-agent`, then run `pi` and `/login` (or provide a supported provider API key).

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

For an account that already has an approved browser, start a new computer using
that account's email:

```bash
npx ftown setup
npx ftown start --account you@example.com --api-url http://localhost:3000
```

Review it in **Security → Devices → Pending approvals**, compare both local
codes and confirm on both devices. Use HTTPS or trustworthy localhost for the
browser. With no approved browser yet, explicitly choose
`npx ftown start --bootstrap --api-url http://localhost:3000` and follow its
first-computer private-link setup instead.

Completed pairing stores a 30-day rotating refresh token under the bridge data
directory (`~/.ftown/data/refresh-token`, `0600`); normal restarts reuse it.
The explicit legacy `--token <bootstrap-jwt>` path remains available. **Generate
bridge token** in the dashboard obtains its short-lived token from the
session-gated `POST /api/auth/bridge/bootstrap` (audience
`ftown:bridge-bootstrap`). This authenticates the computer but does not grant
account encryption authority; use its independent approval or explicit migration.

Run setup from the package entrypoint before first start. For an upgrade, use
the exact new package version shown by the startup readiness hint:

```bash
npx ftown@<new-version> setup
```

This installs that version's CLI/runtime assets, hooks/plugins, ftown skill and
PATH entries. Start that copied version with `ftown start`, or use
`ftown start --solo` for Solo. `npx ftown start` accepts the same options. The
installed alias runs independently of the original npm cache and does not fetch
or discover a newer package. `npx ftown-bridge` remains a compatible launcher.
Ordinary bridge starts only check readiness and write runtime connection state.
Use installed `ftown setup --repair` to recheck the current copied version,
restore its missing assets, or detect newly installed integrations. If its runtime
is incomplete, use the matching package entrypoint above with `--repair`.
Setup keeps completed cleanup migration IDs across package upgrades; repair can
safely repeat them while preserving customized assets and saved data.

Setup provides:

- `ftown` — `setup`, `start`, `sessions`, `harness`, and `env` commands (existing launchers remain compatible)
- `~/.ftown/harness-agent.md` — short pointer to the authoritative installed ftown skill
- `~/.ftown/bridge.json` — port + token while bridge is running

```bash
ftown harness status
ftown harness here -n 20
ftown harness ls
```

### Hosted upgrade ordering

Pending approvals requires [`0008_pending_approvals.sql`](ui/migrations/0008_pending_approvals.sql).
Merge its prerequisite schema PR and verify that the production **migrate** job
succeeds **before merging or promoting the pending-approvals feature PR**. Keep the
feature rollout blocked if migration fails. The old app tolerates the additive
schema; the new app requires the pending table, including for legacy pairing.
Vercel deployment and the migration workflow run concurrently, so an automatic
app deployment does not wait for migration success.

## Agent control over MCP

Connect an assistant to the remote Streamable HTTP MCP server at
`https://ftown-mcp.fly.dev/mcp` (or your own deployed gateway URL). Use the
client's OAuth connection flow, sign in to FTown and select the computers and
read/control access to authorize. The client needs Streamable HTTP, public OAuth
with S256 PKCE and resource indicators; there is no local stdio command or bridge
token to paste into it. Computers must be paired and registered in the gateway.
Self-hosted setup and configuration are in the [MCP guide](docs/mcp.md).

- **Fleet and sessions:** discover authorized computers, inspect current sessions,
  create tasks, rename/reparent, stop/retry, archive/revive, read token usage and
  search retained terminal history. Keep both the machine and session ID.
- **Mail and terminals:** send durable threaded messages or broadcasts, observe
  inboxes without consuming agent mail, and send exact terminal input or resize
  requests when authorized.
- **Durable attention:** `attention_inbox` reads supported human-input requests;
  `attention_wait` waits across selected sessions with reconnect cursors.
  `attention_ack` acknowledges delivery and `attention_resolve` updates the record;
  neither answers or approves the source prompt.

Upgrade each bridge for durable attention capture. Supported hooks write requests
to its local ledger before acknowledging them, so captured requests survive
restarts and gateway outages. Capture depends on the harness's supported hooks;
terminal text and idle state do not establish a request. A bounded
`attention_wait` can emit standard progress notifications when the client supplies
`_meta.progressToken`. Clients must call inbox/wait again or reconnect with their
cursors; this does not promise unsolicited wake-up of an inactive assistant.
See [identity and attention details](docs/mcp.md#identity-and-durable-attention).

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

Run all three components on a single machine accessible to your LAN. If you just want a single-port, no-account LAN deployment with everything staying on your network, see [Solo mode](#solo-mode--runs-entirely-on-your-network) instead.

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
npx ftown setup
npx ftown start --token <jwt> --api-url http://192.168.1.100:3000
```

Get the token via **Generate bridge token** in the dashboard at
`http://192.168.1.100:3000` (see Quick Start above).

---

### Hosted production

The target production layout uses Fly.io for Centrifugo, Vercel for the UI,
and Neon for the database. See the hardened, rollback-safe
[Fly.io rollout runbook](docs/centrifugo-fly-rollout.md).

#### Legacy Centrifugo on EC2

The EC2 instructions below are retained for rollback and self-hosting. New
hosted deployments should use the Fly.io runbook above.

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
2. Run `ui/schema.sql` against the database once for a fresh install (use the Neon SQL editor or `psql`)
3. Copy the connection string to Vercel env vars

##### Migrations (auto-applied on merge to main)

Incremental schema changes live in `ui/migrations/*.sql`. They are applied
**automatically** by the `.github/workflows/migrate.yml` GitHub Actions workflow
on every push to `main` (and via manual **workflow_dispatch**). Automation applies
the SQL, but schema-dependent features still require migration success before
feature merge or promotion; follow [hosted upgrade ordering](#hosted-upgrade-ordering).

One-time setup: add a repo secret **`MIGRATION_DATABASE_URL`** = a Neon **direct**
`postgresql://` connection string (the standard TCP host, **not** the
`@neondatabase/serverless` HTTP host the app uses). The runner
(`ui/scripts/migrate.mjs`) tracks applied files in a `schema_migrations` table,
runs each pending migration in a single transaction, and is idempotent (safe to
re-run, and safe even if a migration was already applied by hand). The workflow
runs concurrently with Vercel's deploy on the same push. Additive migrations keep
the existing app compatible with the expanded schema; they do not make a new
schema-dependent app compatible with the old schema. For pending approvals,
merge prerequisite migration0008 and verify its production migrate job succeeds
before the feature PR is merged or promoted, as described in
[hosted upgrade ordering](#hosted-upgrade-ordering).

#### Bridge

On any machine where you want to run Claude or Cursor Agent sessions:

```bash
npx ftown setup
npx ftown start --account you@example.com --api-url https://your-domain.vercel.app
```

Review the new computer from an approved account browser, compare its local
verification code and confirm on both devices. Use explicit `--bootstrap` only
for first-account/private-link setup; an account routing email is not approval.

## Upgrade notes

The dashboard can check an approved bridge for a stable update. Assisted updates
are enabled by default for an unsupervised single bridge on POSIX, started from
its installed CLI with `ftown start` and the default FTown home and data directory.
Use `ftown start --no-allow-updates` to disable them; older bridges may need
`ftown start --allow-updates`. Updates still require explicit confirmation and
never install in the background. Stop all running or pending sessions first; the
update briefly disconnects the bridge. Windows, Solo, development builds, custom
instances and service-managed bridges use their normal manager or manual setup
instructions. If the latest release requires a newer Node version, upgrade Node
on that computer before updating the bridge.

If setup or restart fails, FTown does not promise an automatic rollback. Run
`npx ftown@<exact-version> setup --repair` with the target version shown in the
update status, then start the bridge with its usual nonsecret options. The private
operation receipt is `~/.ftown/updates/operation.json`. Application updates are
separate: reload the page only when ready to reconnect and lose any unsent input.

Factory and recurring interval/cron automation was retired in bridge 0.19.38.
Saved definitions, run histories and project files are preserved but inactive.
Read the [retirement and rollback notes](docs/automation-sunset.md) before upgrading
or downgrading bridges.

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
