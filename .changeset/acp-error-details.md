---
'@manyfold/api': patch
---

Surface the gateway's `data.details` in ACP turn errors instead of collapsing them to a bare "Internal error". The openclaw/hermes gateway returns a generic top-level message (`-32603 Internal error`) and puts the real cause — a provider rejection, an invalid parameter, a model error — in `error.data.details`. The ACP client dropped it, so a failed turn showed only "Internal error" with no way to tell what actually went wrong. Now the chat error reads e.g. `Internal error: model gpt-5.6-terra: <provider message>`.
