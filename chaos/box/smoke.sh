#!/bin/sh
# Host-side smoke: build the box, run it with --network none, prove solo start,
# session create (root + child), mail delivery, tmux, and survival of kill -9 + restart.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tag=ftown-chaos-box:dev
start=$(date +%s)
# Stage the fingerprint list and build from it. A docker build of the live
# repo root would COPY gitignored files: Dockerfile.dockerignore matches nothing.
(cd "$here/.." && npm run test:chaos -- build)
echo "build: $(( $(date +%s) - start ))s"
docker image inspect "$tag" --format 'image size: {{.Size}} bytes'
docker run --rm --platform linux/amd64 --network none "$tag" /bin/sh /opt/chaos/box/in-box-smoke.sh
