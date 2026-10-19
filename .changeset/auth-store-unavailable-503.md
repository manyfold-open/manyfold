---
'@manyfold/api': minor
---

A brief database hiccup no longer looks like a bad credential. Sessions, API tokens and daemon tokens keep working while the database cannot take writes (for example for a moment during a failover), and a credential that cannot be checked right now is answered `503` — `api_error` / `auth_unavailable` on the OpenAI-compatible API, WebSocket close `1011` for daemons and terminals — instead of `401`. Browsers stay signed in, daemons reconnect on their normal schedule instead of backing off as if their token were revoked, and the database's error text is no longer sent to A2A callers.
