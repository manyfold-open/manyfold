---
'@manyfold/api': minor
---

Managed model channels now recognise an empty account pool when the gateway reports it as `503 Service temporarily unavailable`, including the plain-text form codex prints. The channel breaker opens on the first such turn, so later turns end at once with the channel-unavailable message instead of each running the CLI's full retry chain against the empty pool.
