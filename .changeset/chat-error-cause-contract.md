---
'@manyfold/api': minor
'@manyfold/web': patch
---

Chat errors now include a server-classified cause used by the web workbench and
terminal telemetry. Live events, replayed streams and historical messages use
the same classification rules. The web no longer guesses authentication,
billing or thread contention from error wording. Retryability remains the
adapter's explicit decision.
