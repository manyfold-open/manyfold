# syntax=docker/dockerfile:1
ARG MF_RUNTIME_BASE=mf-runtime-base:debian-bookworm
FROM ${MF_RUNTIME_BASE}

ARG CODEX_VERSION=latest

ENV NODE_ENV=production \
    HOME=/home/node

WORKDIR /home/node

RUN npm install -g "@openai/codex@${CODEX_VERSION}"

COPY --chown=node:node entrypoint.sh /home/node/entrypoint.sh
RUN chmod +x /home/node/entrypoint.sh

ENTRYPOINT ["/home/node/entrypoint.sh"]
# The daemon is the container's main process, and it holds the container open
# even when it cannot run (see mf-daemon-boot) — so this is a strict superset of
# the `sleep infinity` it replaced.
CMD ["mf-daemon-boot"]
