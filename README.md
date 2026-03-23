# ftown

A Claude Code orchestrator that lets you manage and stream remote CLI sessions through a web dashboard.

## Architecture

```
┌─────────────┐     WebSocket      ┌────────────┐     WebSocket      ┌─────────────┐
│   Browser    │◄──────────────────►│ Centrifugo  │◄──────────────────►│   Bridge    │
│  (Next.js)   │                    │  (pub/sub)  │                    │ (node-pty)  │
└─────────────┘                    └────────────┘                    └─────────────┘
```

- **UI** (`/ui`) — Next.js 15 web dashboard with real-time terminal streaming via xterm.js
- **Bridge** (`/bridge`) — CLI tool that runs on remote machines, spawns processes via PTY and relays I/O through Centrifugo
- **Centrifugo** (`/centrifugo`) — WebSocket messaging server connecting bridge and UI in real-time

## Features

- Real-time terminal streaming from remote machines to browser
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
