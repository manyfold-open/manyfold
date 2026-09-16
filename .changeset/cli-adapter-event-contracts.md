---
'@manyfold/api': patch
---

Preserve Gemini CLI snake-case tool call IDs, names, parameters and correlated results during dispatch and replay. Classify explicit Codex overload and HTTP 429 retry-limit exits as retryable provider failures, with distinct bounded causes and no automatic replay.
