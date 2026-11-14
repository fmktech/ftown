#!/usr/bin/env bash
# Keeps the CI instance alive: Docker (for the e2e/centrifugo stacks) in the
# background, sshd in the foreground on port 22022.
set -u
mkdir -p /var/run/sshd /home/node/ci
ssh-keygen -A >/dev/null 2>&1 || true
if command -v dockerd >/dev/null 2>&1; then
  dockerd >/var/log/dockerd.log 2>&1 &
fi
exec /usr/sbin/sshd -D -e -p 22022
