# Direct local browser control

Choose **This computer** on the hosted login page or cloud dashboard to manage a
bridge on the same computer without cloud login. Session and loop operations use
the same bridge controllers as cloud mode; terminals connect over loopback.

## Coming from Cloud

When the authenticated cloud dashboard sees this computer's bridge, it uses the
bridge's cloud-issued local capability to establish remembered local access
automatically. Choose **This computer** to switch without `ftown-bridge pair` or
a second terminal. The dashboard prepares this access while cloud is available,
so it also works after Fly disconnects. Browser local-network permission may
still be required.

Only a matching bridge identity and allowed browser origin can exchange that
capability. Remote bridges cannot authorize a different bridge on this computer.
A saved credential that was revoked is not silently replaced by background
polling. Devices established from Cloud can be listed and revoked with the same
CLI commands below.

## Start and approve without Cloud

For a bridge that never contacts the cloud:

```sh
ftown-bridge --local
```

An ordinary cloud-connected bridge also exposes local approval. In a second
terminal, run:

```sh
ftown-bridge pair
```

Open the `/local?port=...` link printed by the command, click **Connect locally**,
and compare its six-digit code with the terminal. Approve only the matching
request. Approval grants command execution and terminal/session control on that
computer. A browser reaching the port alone does not authorize it.

For a bridge with a custom data directory, pass the same `--data-dir` to `pair`,
`devices`, and `revoke`. The allowed browser origin is the bridge's `--api-url`
(default `https://ftown.ia.br`); for development, start with
`--api-url http://localhost:3000` and use that exact origin.

**Remember this browser** stores the credential in that origin's local storage.
Unchecked, it uses tab session storage and the bridge keeps its credential only
until the bridge exits. Credentials are bound to the bridge identity and exact
browser origin; only hashes are persisted on the bridge.

```sh
ftown-bridge devices
ftown-bridge revoke <device-id>
```

Revocation removes that credential and disconnects existing loopback terminals.
Other approved browsers may reconnect. **Forget saved access** removes the
browser's saved credential; use `revoke` to invalidate it on the bridge too.

## Outages and restarts

While the local bridge runs, the local dashboard supports creating, removing,
renaming, stopping, and retrying sessions, managing loops, and using terminals
without Fly. The cloud dashboard's **This computer** link switches to this local
route. It does not automatically replay a cloud command whose delivery is
uncertain, or switch the dashboard back to cloud mode.

The local dashboard retries its event connection and terminal connection after a
local transport interruption. A missed event history triggers a fresh snapshot.
Mutation requests are not automatically retried; the bridge deduplicates repeated
request IDs for ten minutes after completion (up to 1,000 retained commands).

The bridge reuses its saved loopback port on restart. If another process occupies
that port, it selects a new one; run `pair` and use the new link. A changed bridge
identity or revoked credential requires approval again.

The hosted UI still needs to load initially from its host. This change does not
add a PWA or offline UI cache. Browsers may request local-network permission;
that permission and local bridge approval are both necessary. `--local` binds
only to loopback, so it controls this computer, not another LAN machine. Existing
`--solo` remains the bundled LAN panel/hub deployment described in [solo.md](solo.md).
