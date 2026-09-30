---
'@manyfold/api': minor
---

`POST /api/v1/chat/completions` now accepts request bodies up to its intended 32 MiB (base64 file content). Before, it answered `413` above Fastify's 1 MiB default, because the limit a route declares with `@RouteConfig({ bodyLimit })` was never applied.
