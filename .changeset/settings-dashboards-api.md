---
'@manyfold/api': minor
---

Two read-only endpoints behind the new settings dashboards.

`GET /me/model-providers/usage?from=&to=` returns spend, tokens, requests and
last use grouped by model provider for the calling user. The aggregation
already existed for admins; this is the same GROUP BY, scoped to one user and
shared with the admin path so the two can never disagree about how spend is
computed. Two things it does differently: the unattributed group — turns whose
agent had no provider bound, or whose provider row was deleted — is kept
rather than dropped, and `costUsd` is left null when nothing in the group
carried a price, with `unpricedEventCount` saying how many turns are missing
one. Null cost means unknown, not free.

`GET /channels/activity?windowDays=` returns per-channel delivery counts and
the last inbound/outbound timestamps. The counts cover a window because
`channel_deliveries` is pruned, and the resolved `windowDays` comes back in the
response clamped to the deployment's `CHANNEL_DELIVERY_RETENTION_DAYS`, so a
host that keeps seven days can never have a seven-day count labelled as thirty.
Timestamps come from `channel_sessions`, which is never pruned, so they are
lifetime values. Inbound counts every delivery; outbound counts only the ones
that reached the platform.

No migration — both queries are served by existing indexes.
