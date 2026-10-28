#!/usr/bin/env bash
set -euo pipefail
umask 022
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo "Linux x86_64 required" >&2; exit 1; }
if [[ $(node --version 2>/dev/null || true) != v24.22.1 ]]; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  curl --fail --location --retry 3 --connect-timeout 15 --max-time 180 https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz -o "$work/node.tar.xz"
  sudo tar -xJf "$work/node.tar.xz" -C /usr/local --strip-components=1
  export PATH="/usr/local/bin:$PATH"
  hash -r
  rm -rf "$work"
  trap - EXIT
fi
[[ $(node --version) == v24.22.1 ]] || { echo "Node 24.22.1 required" >&2; exit 1; }
node --version
npm --version
