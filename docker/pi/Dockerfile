# syntax=docker/dockerfile:1
ARG MF_RUNTIME_BASE=mf-runtime-base:debian-bookworm
FROM ${MF_RUNTIME_BASE}

# pi (pi.dev) requires Node >= 22.19; the base image's mise `node@22` resolves
# to the current 22.x, which satisfies it. Pin PI_VERSION to a release for a
# reproducible image (the API's version catalog can still upgrade in place).
ARG PI_VERSION=latest

ENV NODE_ENV=production \
    HOME=/home/node \
    # No update check or telemetry from inside a pod; every chat exec sets the
    # same variable, this covers `pi --version` probes and terminals too.
    PI_OFFLINE=1

WORKDIR /home/node

# pi's `find` and `grep` tools run fd and ripgrep. pi fetches them itself only
# when it may go online, and PI_OFFLINE is set above and on every exec, so the
# image carries them (Debian names fd `fdfind`, which pi looks for as well).
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ripgrep fd-find \
    && rm -rf /var/lib/apt/lists/*
USER node

RUN npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && pi --version

COPY --chown=node:node entrypoint.sh /home/node/entrypoint.sh
RUN chmod +x /home/node/entrypoint.sh

ENTRYPOINT ["/home/node/entrypoint.sh"]
# The daemon is the container's main process, and it holds the container open
# even when it cannot run (see mf-daemon-boot) — so this is a strict superset of
# the `sleep infinity` it replaced.
CMD ["mf-daemon-boot"]
