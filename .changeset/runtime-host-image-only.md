---
'@manyfold/api': minor
'@manyfold/web': minor
---

Only the pod host image is built and published now: every cloud computer runs `manyfold-runtime-host` and installs its frameworks on demand, so the per-framework runtime images (`manyfold-runtime-base`, `-runner`, `-claude-code`, `-codex`, `-gemini-cli`, `-pi`, `-openclaw`, `-hermes`), their recipes and their local build recipes are gone. Tags already published stay pullable. The buy-container page describes a cloud computer that frameworks are installed on, rather than a pod with a framework runtime.
