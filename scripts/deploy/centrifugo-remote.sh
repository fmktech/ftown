#!/usr/bin/env bash
# centrifugo-remote.sh — runs ON the centrifugo EC2 host.
#
# Usage: sh centrifugo-remote.sh <path-to-new-config>
#
# Self-detects how centrifugo is deployed (a running docker container OR a
# systemd unit), backs up the live config (timestamped .bak), swaps in the new
# config, restarts, then health-checks. If the health check fails it RESTORES
# the backup, restarts again, and exits non-zero.
#
# SECURITY: the config contains secrets. This script NEVER cats/prints the
# config; it only extracts individual NON-secret numeric fields (ports) with a
# targeted digit-only pattern.
set -eu

NEW_CONFIG="${1:-}"
if [ -z "$NEW_CONFIG" ] || [ ! -f "$NEW_CONFIG" ]; then
  echo "ERROR: usage: $0 <path-to-new-config> (file must exist)" >&2
  exit 1
fi

# The uploaded config holds real secrets. Remove it whenever this script exits
# (success OR failure) so secret hygiene never depends on a later CI ssh call.
trap 'rm -f "$NEW_CONFIG" 2>/dev/null || true' EXIT

TS="$(date +%Y%m%d%H%M%S)"
LAYOUT=""        # "docker" | "systemd"
CONTAINER=""
UNIT=""
LIVE_CONFIG=""
BACKUP=""
SUDO=""
INTERNAL_PORT=""
PORT=""

log() { printf '[centrifugo-deploy] %s\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# Read a numeric field from the NEW config without printing the file. Prints
# only the integer value (ports are not secret) or nothing.
read_port() {
  # $1 = field name, e.g. internal_port. The leading quote in the pattern means
  # "port" never matches inside "internal_port".
  grep -oE "\"$1\"[[:space:]]*:[[:space:]]*[0-9]+" "$NEW_CONFIG" 2>/dev/null \
    | grep -oE '[0-9]+$' | head -n1 || true
}

# Pull a -c / --config path out of a whitespace-separated argument stream on
# stdin. Prints the path or nothing.
extract_config_arg() {
  awk '
    prev == "-c" || prev == "--config" { print; exit }
    /^-c=/        { sub(/^-c=/, "", $0); print; exit }
    /^--config=/  { sub(/^--config=/, "", $0); print; exit }
    { prev = $0 }
  '
}

detect_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  CONTAINER="$(docker ps --format '{{.ID}} {{.Image}}' 2>/dev/null \
    | awk 'tolower($2) ~ /centrifugo/ { print $1; exit }')"
  [ -n "$CONTAINER" ] || return 1

  # In-container config path from the container's args (default if not passed).
  cfg_in="$(docker inspect --format '{{range .Args}}{{println .}}{{end}}' "$CONTAINER" 2>/dev/null \
    | extract_config_arg)"
  [ -n "$cfg_in" ] || cfg_in="/centrifugo/config.json"

  # A relative -c arg (e.g. this repo's compose runs `centrifugo -c config.json`)
  # is resolved against the container WorkingDir before matching Mounts — a
  # relative path can never equal/prefix an absolute Mount destination.
  case "$cfg_in" in
    /*) : ;;
    *)
      workdir="$(docker inspect --format '{{.Config.WorkingDir}}' "$CONTAINER" 2>/dev/null)"
      [ -n "$workdir" ] || workdir="/"
      case "$workdir" in
        */) cfg_in="${workdir}${cfg_in}" ;;
        *)  cfg_in="${workdir}/${cfg_in}" ;;
      esac
      ;;
  esac

  # Map the in-container path to a host path via the container Mounts.
  LIVE_CONFIG="$(docker inspect \
    --format '{{range .Mounts}}{{.Source}}|{{.Destination}}{{println}}{{end}}' "$CONTAINER" 2>/dev/null \
    | awk -v c="$cfg_in" '
        {
          n = index($0, "|"); src = substr($0, 1, n - 1); dst = substr($0, n + 1);
          if (dst == c) { print src; exit }
          if (substr(c, 1, length(dst) + 1) == dst "/") { print src substr(c, length(dst) + 1); exit }
        }')"
  [ -n "$LIVE_CONFIG" ] \
    || die "docker: could not map in-container config '$cfg_in' to a host path via Mounts (container=$CONTAINER)"

  LAYOUT="docker"
  return 0
}

detect_systemd() {
  command -v systemctl >/dev/null 2>&1 || return 1
  UNIT="$(systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null \
    | awk '{ print $1 }' | grep -i centrifugo | head -n1)"
  [ -n "$UNIT" ] || UNIT="$(systemctl list-units --type=service --all --no-legend --no-pager 2>/dev/null \
    | awk '{ print $1 }' | grep -i centrifugo | head -n1)"
  [ -n "$UNIT" ] || return 1

  execstart="$(systemctl show -p ExecStart --value "$UNIT" 2>/dev/null || true)"
  cfg="$(printf '%s\n' "$execstart" | tr ' ' '\n' | extract_config_arg)"
  [ -n "$cfg" ] || cfg="/etc/centrifugo/config.json"
  LIVE_CONFIG="$cfg"

  LAYOUT="systemd"
  return 0
}

set_sudo() {
  if [ -w "$LIVE_CONFIG" ]; then
    SUDO=""
  elif [ ! -e "$LIVE_CONFIG" ] && [ -w "$(dirname "$LIVE_CONFIG")" ]; then
    SUDO=""
  else
    command -v sudo >/dev/null 2>&1 \
      || die "need root to write $LIVE_CONFIG but sudo is not available"
    SUDO="sudo"
  fi
}

backup_live() {
  if [ -f "$LIVE_CONFIG" ]; then
    BACKUP="${LIVE_CONFIG}.bak.${TS}"
    $SUDO cp -p "$LIVE_CONFIG" "$BACKUP"
    log "backed up live config -> $BACKUP"
  else
    log "no existing config at $LIVE_CONFIG (fresh install; nothing to back up)"
  fi
}

install_config() {
  # Write to a temp file then atomically move it into place so a running
  # centrifugo never sees a half-written config.
  tmp="${LIVE_CONFIG}.new.${TS}"
  $SUDO cp "$NEW_CONFIG" "$tmp"
  $SUDO mv "$tmp" "$LIVE_CONFIG"
  log "installed new config -> $LIVE_CONFIG"
}

restore_backup() {
  if [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then
    # Same atomic temp-file-then-mv as install_config: an interrupted rollback
    # must never leave LIVE_CONFIG half-written — exactly when a clean config
    # matters most.
    tmp="${LIVE_CONFIG}.restore.${TS}"
    $SUDO cp "$BACKUP" "$tmp"
    $SUDO mv "$tmp" "$LIVE_CONFIG"
    log "restored backup $BACKUP -> $LIVE_CONFIG"
  else
    log "no backup available to restore"
  fi
}

restart_service() {
  case "$LAYOUT" in
    docker)  docker restart "$CONTAINER" >/dev/null; log "restarted docker container $CONTAINER" ;;
    systemd) $SUDO systemctl restart "$UNIT";        log "restarted systemd unit $UNIT" ;;
    *)       die "restart_service: unknown layout '$LAYOUT'" ;;
  esac
}

is_up() {
  case "$LAYOUT" in
    docker)  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ] ;;
    systemd) systemctl is-active --quiet "$UNIT" ;;
    *)       return 1 ;;
  esac
}

# Host-loopback probe: works for a native (systemd) install, a --network host
# container, or one that publishes its ports. Prints nothing; returns 0 only on
# a positive answer.
probe_host() {
  command -v curl >/dev/null 2>&1 || return 1
  # Prefer the internal /health endpoint when an internal_port is configured.
  if [ -n "$INTERNAL_PORT" ]; then
    if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:${INTERNAL_PORT}/health"; then
      return 0
    fi
  fi
  # Fall back to the public websocket endpoint: ANY HTTP status (400 = "you
  # didn't send a websocket upgrade") proves centrifugo is answering.
  if [ -n "$PORT" ]; then
    code="$(curl -ksS -o /dev/null -w '%{http_code}' --max-time 3 \
      "https://127.0.0.1:${PORT}/connection/websocket" 2>/dev/null || echo 000)"
    if [ -n "$code" ] && [ "$code" != "000" ]; then
      return 0
    fi
  fi
  return 1
}

# Probe from INSIDE the container so health works regardless of whether the host
# publishes centrifugo's ports (a bridged container without -p wouldn't be
# reachable on 127.0.0.1 from the host — the exact case that used to make the
# health check roll back a perfectly good config).
probe_docker() {
  if [ -n "$INTERNAL_PORT" ]; then
    for client in wget curl; do
      rc=0
      case "$client" in
        wget) docker exec "$CONTAINER" wget --no-verbose --tries=1 --spider \
                --timeout=3 "http://127.0.0.1:${INTERNAL_PORT}/health" \
                >/dev/null 2>&1 || rc=$? ;;
        curl) docker exec "$CONTAINER" curl -fsS -o /dev/null --max-time 3 \
                "http://127.0.0.1:${INTERNAL_PORT}/health" >/dev/null 2>&1 || rc=$? ;;
      esac
      if [ "$rc" -eq 0 ]; then
        return 0
      fi
      # 126/127 = this client isn't in the image; try the next. Any other
      # non-zero is authoritative (centrifugo not answering inside the
      # container), so report unhealthy — the retry loop absorbs slow starts.
      if [ "$rc" -ne 126 ] && [ "$rc" -ne 127 ]; then
        return 1
      fi
    done
  fi
  # No usable in-container client (or no internal_port). Try the host loopback.
  if probe_host; then
    return 0
  fi
  # We could neither probe inside the container nor over the host loopback, so
  # we cannot actually disprove health. Degrade to container-running state
  # rather than roll back (and discard) a config we can't show is bad.
  log "WARN: could not HTTP-probe centrifugo (no in-container client; host loopback unreachable); relying on container-running state only"
  return 0
}

http_probe() {
  case "$LAYOUT" in
    docker)
      probe_docker
      ;;
    systemd)
      # Native install: the host loopback is authoritative.
      if probe_host; then
        return 0
      fi
      if ! command -v curl >/dev/null 2>&1; then
        log "WARN: curl not found; health relies on process state only"
        return 0
      fi
      return 1
      ;;
    *)
      return 1
      ;;
  esac
}

health_check() {
  i=1
  while [ "$i" -le 30 ]; do
    if is_up && http_probe; then
      log "health check passed (attempt $i/30)"
      return 0
    fi
    log "health check attempt $i/30 not ready; retrying in 2s"
    sleep 2
    i=$((i + 1))
  done
  return 1
}

# ---- main -------------------------------------------------------------------
log "starting centrifugo config deploy (source: $NEW_CONFIG)"

if detect_docker; then
  log "detected DOCKER layout: container=$CONTAINER live_config=$LIVE_CONFIG"
elif detect_systemd; then
  log "detected SYSTEMD layout: unit=$UNIT live_config=$LIVE_CONFIG"
else
  {
    echo "ERROR: could not detect a centrifugo deployment. Checked:"
    if command -v docker >/dev/null 2>&1; then
      echo "  - docker: installed, but no running container has an image matching /centrifugo/"
    else
      echo "  - docker: not installed"
    fi
    if command -v systemctl >/dev/null 2>&1; then
      echo "  - systemd: available, but no service unit matches 'centrifugo'"
    else
      echo "  - systemd: systemctl not available"
    fi
  } >&2
  exit 1
fi

set_sudo
INTERNAL_PORT="$(read_port internal_port)"
PORT="$(read_port port)"
log "health ports: internal_port='${INTERNAL_PORT:-unset}' port='${PORT:-unset}'"

backup_live
install_config
restart_service

if health_check; then
  log "deploy OK: centrifugo is healthy with the new config"
  exit 0
fi

log "HEALTH CHECK FAILED after applying new config — rolling back"
restore_backup
restart_service
if health_check; then
  log "rollback succeeded: old config restored and healthy. New config was REJECTED."
else
  log "rollback restart is ALSO unhealthy — MANUAL INTERVENTION REQUIRED on the host"
fi
exit 1
