---
'@manyfold/api': patch
---

Fix openclaw chat over ACP failing on sprites with `openclaw acp exited with code 1`. The bridge now creates and enters the agent workspace itself instead of passing it as the exec working directory — a fresh sprite creates that workspace lazily, so `cd`-ing into it failed before openclaw started — and the gateway session binds to the sprite gateway's actual agent (`main`) rather than the internal agent id, which the gateway rejects as "no longer exists in configuration". Per-message model switching over ACP now takes effect.
