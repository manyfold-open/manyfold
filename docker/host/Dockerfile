# syntax=docker/dockerfile:1
# The one runtime image a Kubernetes pod host runs (ADR-0035). It carries the
# toolchains and the OS packages frameworks need, and no framework: the API
# installs frameworks on demand into the home directory, which is the pod's
# PVC. Everything the image provides therefore lives outside /home/node — the
# PVC mounted there hides whatever an image puts under it.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# What a framework needs from the OS and a non-root install cannot add later:
# ripgrep and fd for pi, ffmpeg for media tools, and the libraries a headless
# Chromium (the Playwright build OpenClaw installs) links against.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl bash git jq coreutils procps tar gzip \
        gnupg build-essential libffi-dev xz-utils \
        ripgrep fd-find ffmpeg \
        libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 \
        libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 \
        libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
        libxfixes3 libxkbcommon0 libxrandr2 fonts-liberation \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1000 node \
    && useradd --uid 1000 --gid node --create-home --home-dir /home/node --shell /bin/bash node \
    && mkdir -p /opt/mise /opt/manyfold/bin \
    && chown -R node:node /opt/mise /opt/manyfold

RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh

# A login shell — what pod exec runs — starts from /etc/profile, which resets
# PATH for a non-root user, and the empty home volume has no ~/.profile to
# add anything back; this restores the image's order.
RUN echo 'export PATH="/home/node/.local/bin:/opt/mise/shims:/opt/manyfold/bin:$PATH"' \
        > /etc/profile.d/manyfold-host.sh

COPY --chmod=755 mf-host-boot.sh /usr/local/bin/mf-host-boot

USER node
WORKDIR /home/node

# ~/.local/bin first: a framework or an mf the API installed on the PVC wins
# over anything the image ships. npm's global prefix is ~/.local, so a global
# install lands on the PVC too instead of inside the image's node.
ENV HOME=/home/node \
    MISE_DATA_DIR=/opt/mise \
    MISE_CONFIG_DIR=/opt/mise/config \
    MISE_GLOBAL_CONFIG_FILE=/opt/mise/config/config.toml \
    MISE_CACHE_DIR=/opt/mise/cache \
    MISE_STATE_DIR=/opt/mise/state \
    NPM_CONFIG_PREFIX=/home/node/.local \
    PATH="/home/node/.local/bin:/opt/mise/shims:/opt/manyfold/bin:/usr/local/bin:/usr/bin:/bin"

RUN mise use -g python@3.13 node@22 uv@latest \
    && mise install \
    && mise reshim

# The mf a first boot starts with. The boot script copies it onto the PVC,
# where `daemon.update` can replace it; this copy is also the fallback when an
# update will not start. VERSION must name a published stable release:
# install.sh resolves `cli-v<VERSION>/manifest.json` and fails the build
# otherwise, and the API refuses a daemon below its protocol baseline (0.34.0).
ARG MF_CLI_VERSION=3.0.1
RUN curl -fsSL https://manyfold.ai/cli/install.sh \
        | VERSION="${MF_CLI_VERSION}" MF_INSTALL_DIR=/opt/manyfold/bin sh \
    && /opt/manyfold/bin/mf --version

CMD ["mf-host-boot"]
