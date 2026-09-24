# syntax=docker/dockerfile:1
ARG MF_RUNTIME_BASE=mf-runtime-base:debian-bookworm
FROM ${MF_RUNTIME_BASE}

ARG OPENCLAW_VERSION=2026.5.18

ENV NODE_ENV=production \
    OPENCLAW_HOME=/home/node

WORKDIR /home/node

RUN npm install -g "openclaw@${OPENCLAW_VERSION}"

COPY --chown=node:node entrypoint.sh /home/node/entrypoint.sh
RUN chmod +x /home/node/entrypoint.sh

EXPOSE 18789
ENTRYPOINT ["/home/node/entrypoint.sh"]
CMD ["openclaw", "gateway"]
