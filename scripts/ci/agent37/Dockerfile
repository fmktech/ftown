# CI template image for the Agent37 runner (scripts/ci/agent37-runner.mjs).
# Build once per toolchain change and register as template `ftown-ci`:
#   a37 image build scripts/ci/agent37/Dockerfile ftown-ci scripts/ci/agent37
# Existing instances keep the old revision until `a37 update` recreates them.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_VERSION=24.22.1
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq rsync xz-utils \
      openssh-server sudo zsh tmux \
      python3 make g++ \
      docker.io docker-compose-v2 \
      libnss3-tools \
    && rm -rf /var/lib/apt/lists/*

# Node 24.22.1, installed the same way scripts/ci/setup-runtime.sh does, so the
# remote run-job.sh finds the exact version it requires on PATH.
RUN curl --fail --location --retry 3 --connect-timeout 15 --max-time 300 \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && node --version && npm --version

# Unprivileged CI user (the platform's default SSH user) with passwordless sudo:
# run-job.sh uses sudo for apt installs and binding port 443.
RUN useradd -m -s /bin/bash node \
    && echo 'node ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node \
    && usermod -aG docker node || true \
    && mkdir -p /home/node/.ssh /home/node/ci \
    && chmod 700 /home/node/.ssh \
    && chown -R node:node /home/node

# Bake Playwright's Chromium and its OS dependencies (pinned to the e2e suite's
# version) so CI runs skip the download; run-job.sh still calls
# `playwright install --with-deps` and reuses this cache when versions match.
RUN npm install -g @playwright/test@1.49.1 \
    && su node -c "playwright install --with-deps --no-shell chromium" \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# SSH server on the port the platform expects. Host keys are generated on first
# boot by the entrypoint; authorized keys are injected by the platform from the
# account's registered SSH keys.
RUN mkdir -p /var/run/sshd \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config

COPY entrypoint.sh /usr/local/bin/ftown-ci-entrypoint.sh
RUN chmod 0755 /usr/local/bin/ftown-ci-entrypoint.sh

WORKDIR /home/node
EXPOSE 22022
ENTRYPOINT ["/usr/local/bin/ftown-ci-entrypoint.sh"]
