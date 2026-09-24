# syntax=docker/dockerfile:1
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl bash git jq coreutils procps tar gzip \
        gnupg build-essential libffi-dev xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1000 node \
    && useradd --uid 1000 --gid node --create-home --home-dir /home/node --shell /bin/bash node

RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh

USER node
WORKDIR /home/node

ENV MISE_DATA_DIR=/home/node/.local/share/mise \
    PATH="/home/node/.local/share/mise/shims:/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin"

RUN mise use -g python@3.13 node@22 uv@latest \
    && mise install \
    && mise reshim

# The Manyfold CLI, and with it the daemon a pod uses to carry its own turns.
# Pinned by tag rather than self-updating: in a container the daemon reports
# startup method 'manual', which makes it refuse `daemon.update` and disable
# auto-update — so the image IS the version, and moving it is a deploy.
#
# VERSION must name a PUBLISHED stable release: install.sh resolves it to
# `cli-v<VERSION>/manifest.json` on GitHub Releases and fails the build if it
# is not there (0.31.x, for example, exists only on the rolling dev channel).
# The API requires the daemon protocol baseline (CLI 0.34.0), so
# any published stable release at or above that is a valid pin.
ARG MF_CLI_VERSION=0.34.0
RUN curl -fsSL https://manyfold.ai/cli/install.sh \
        | VERSION="${MF_CLI_VERSION}" MF_INSTALL_DIR="/home/node/.local/bin" sh \
    && /home/node/.local/bin/mf --version

COPY --chown=node:node mf-daemon-boot.sh /home/node/.local/bin/mf-daemon-boot
COPY --chown=node:node mf-service-boot.sh /home/node/.local/bin/mf-service-boot
RUN chmod +x /home/node/.local/bin/mf-daemon-boot /home/node/.local/bin/mf-service-boot
