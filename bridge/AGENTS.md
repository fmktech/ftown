# Bridge package — agent notes

## Harness (local session control)

`ftown-bridge` auto-deploys on every start:

- `~/.ftown/bin/ftown-harness` — stable CLI entry (wrapper → package `harness-cli.js`)
- `~/.ftown/bridge.json` — port, token, `harness` path
- `~/.ftown/harness-agent.md` — cheat sheet for agents (regenerated each start)

Implement harness features in `src/harness-cli.ts` and `src/harness-installer.ts`. Bridge wires install in `src/index.ts` next to hook installation.

### Dev

```bash
npm run harness -- status
npm run build   # publishes bin ftown-harness in package
```

### Tests before PR

```bash
npm run build
npm run harness -- status   # requires running bridge
```
