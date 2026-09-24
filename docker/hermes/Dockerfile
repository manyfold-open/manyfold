# syntax=docker/dockerfile:1
ARG MF_RUNTIME_BASE=mf-runtime-base:debian-bookworm
FROM ${MF_RUNTIME_BASE}

ARG HERMES_REF=main

ENV PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    HERMES_HOME=/home/node/.hermes \
    HERMES_INSTALL_DIR=/opt/hermes/hermes-agent

USER root
RUN mkdir -p /opt/hermes "$HERMES_HOME" \
    && chown -R node:node /opt/hermes "$HERMES_HOME"
USER node

WORKDIR /opt/hermes

RUN git clone --depth 1 --branch "${HERMES_REF}" https://github.com/NousResearch/hermes-agent.git "$HERMES_INSTALL_DIR" \
    && cd "$HERMES_INSTALL_DIR" \
    && uv venv .venv \
    && . .venv/bin/activate \
    && uv pip install --no-cache-dir -e ".[cron,cli,sms,mcp,honcho,web,matrix]" \
    && uv pip install --no-cache-dir fastapi 'uvicorn[standard]' \
    && cd web \
    && npm ci --no-audit --no-fund \
    && npm run build \
    && rm -rf node_modules

ENV PATH="/opt/hermes/hermes-agent/.venv/bin:/home/node/.local/share/mise/shims:/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin"

COPY --chown=node:node entrypoint.sh /home/node/entrypoint.sh
RUN chmod +x /home/node/entrypoint.sh

EXPOSE 8642
ENTRYPOINT ["/home/node/entrypoint.sh"]
CMD ["hermes", "gateway"]
