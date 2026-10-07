---
'@manyfold/api': minor
---

Every closed database connection now emits a `db.connection.closed` event naming its pool (`app`, `bus` or `broker`). Lifetime recycling shows up as an occasional single event. A pooler or network drop shows up as a burst across pools and machines at the same second, so it can be told apart from a single connection. The daemon RPC broker's connections now identify themselves as `mf-api-broker` in `pg_stat_activity` instead of the driver default `postgres.js`.
