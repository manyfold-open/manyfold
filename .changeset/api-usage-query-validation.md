---
'@manyfold/api': minor
---

The usage endpoints, the user's and the admin's, answer `400` for a query they cannot read instead of guessing. A `limit` must be a whole number of at least 1: before, `0` became 1, and `abc` returned an empty events page or the whole agent ranking. A `from`, `to` or `cursor` must be a date or timestamp such as `2026-10-01` or `2026-10-01T09:00:00Z`: before, one that did not parse was dropped and the query covered all time. A time without a zone is UTC. A limit above the maximum is still capped.
