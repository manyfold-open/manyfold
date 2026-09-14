---
'@manyfold/api': patch
---

Preserve Gemini's structured provider error when the CLI exits unsuccessfully, even if startup warnings fill the stderr preview. Redact and bound error summaries before attaching the stderr head and stack tail.
