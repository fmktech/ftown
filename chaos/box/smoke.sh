#!/bin/sh
# Host-side smoke: build the box, run it with --network none, prove solo start,
# session create (root + child), mail delivery, tmux, and survival of kill -9 + restart.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
tag=ftown-chaos-box:dev
start=$(date +%s)
docker build --platform linux/amd64 -f "$root/chaos/box/Dockerfile" -t "$tag" "$root"
echo "build: $(( $(date +%s) - start ))s"
docker image inspect "$tag" --format 'image size: {{.Size}} bytes'
docker run --rm --platform linux/amd64 --network none "$tag" /bin/sh /opt/chaos/box/in-box-smoke.sh
