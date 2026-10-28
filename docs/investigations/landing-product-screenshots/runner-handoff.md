# Capture runner handoff

SITE-RUNNER, Tier 1 `gpt-6.1-terra` / `xhigh`: implemented `e2e/capture/run.sh` and `e2e/capture/README.md`; this file records the handoff. No other files modified under this lease. No Git operations, installs, services, Docker, database, browser or E2E execution were performed.

The wrapper checks the isolated marker, Linux, canonical checkout, actual hostname, tools, selectors, active env files, scratch paths/PIDs/logs, staging path, default local Docker context and empty container set, matching Compose labels and all seven ports before owned setup or schema changes. It acquires a marker, sources and asserts the local E2E selectors/homes, serializes installs, browser download, certificate/trust setup, uniquely named Compose, schema, builds, services and capture. Exit/signal cleanup stops only the existing guarded service helpers and same `-p` Compose project; flags cover partial startup. Primary failure status is retained and cleanup failure is surfaced; a failed cleanup preserves the marker and guarded helpers preserve questionable resources. Staging is retained for review; the wrapper never publishes it.

Checks: `bash -n e2e/capture/run.sh`, `shellcheck -x e2e/capture/run.sh`, `git diff --check` for owned paths, Node syntax checks for all three embedded JavaScript blocks, and static assertions for preflight/trap/Compose/schema ordering and required ports all passed. Static checks do not prove Docker, network, certificate, capture or teardown behavior; root owns the real sandbox execution and verification.

Root command from `/home/user/ftown` in the exclusively owned disposable sandbox:

```sh
FTOWN_CAPTURE_ISOLATED=1 FTOWN_CAPTURE_DIR=/tmp/ftown-product-media bash e2e/capture/run.sh
```

The directory must be empty/new and have an existing canonical parent. Initial v2 capture needs the previously approved v1 UI source/manifest in the source snapshot, because this wrapper rebuilds the UI before capture; sync v2 presentation after genuine v2 assets exist. Future refreshes use committed genuine v2 assets. README includes the Boat setup, OS prerequisites, private review/publication whitelist, failure behavior and deletion verification.

All three file leases released; no resource leases held. Root owns runtime/E2E and `/root/site_integration` owns integration. Escalate any interface or cleanup repair before changing the frozen contract.

## Port and runtime repair

Root observed `EACCES` on an unprivileged bind to port 443 in the clean Boat sandbox. The preflight now requires `ss` from iproute2 and checks the exact local port from every TCP listener, rejecting malformed output and port 443 listeners across IPv4, IPv6 and wildcard addresses. It still bind-probes both IPv4 and IPv6 for the other six required ports. The Node gate now permits only major 24, starting at 24.22.1. The README lists iproute2 and specifies the v1 UI **source and manifest** required for the initial migration, because the wrapper rebuilds the UI.

`bash -n`, `shellcheck -x`, embedded JavaScript parsing and static checks passed. Fixture checks exercised exact 443 rejection for IPv4, IPv6 and wildcard forms; non-443 lookalikes and empty listener lists pass, malformed output fails. Node boundary fixtures accept 24.22.1+ in major 24 and reject older releases and majors 23, 25 and 26. Root must verify actual `ss` output and run the complete wrapper in its owned sandbox; no services, runtime capture, database, installation or Git mutation was run by this worker. Same three file leases released; no resource leases held.
