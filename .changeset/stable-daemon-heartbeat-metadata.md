---
'@manyfold/api': patch
---

Avoid rewriting unchanged daemon metadata when PostgreSQL JSONB returns object keys in a different order. Heartbeats still update presence, and changed framework values or array order continue to update metadata.
