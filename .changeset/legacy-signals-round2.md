---
'@manyfold/api': minor
'@manyfold/admin': patch
'@manyfold/cli': patch
---

Retire the legacy `A2A_TURN_TIMEOUT_MS` env fallback: a startup migration moves a still-set value into the `a2a_turn_timeouts` admin setting exactly once (never overwriting an admin's save), clamping it to the setting bounds (30s floor; 1h blocking / 24h async caps — out-of-range values change behavior and are logged), and the resolver now falls back to code defaults instead of the env var when the setting is absent. The API also warns at startup for every legacy `NCA_*`/`WEB_BASE_URL` env alias still set (key names only) and emits a telemetry event when a Lark channel delivers a pre-2.0 legacy-schema message, so both compatibility windows finally have usage signals. The daemon now advertises the `turn.budgets` capability (it has parsed split turn budgets since #513/#556 — this makes that queryable), and `MF_CHAT_STREAM_FLUSH_MS` / `MF_TURN_ADOPT_REPOLL_MS` are documented in `.env.example`.
