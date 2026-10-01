---
'@manyfold/api': patch
---

Bound OTLP log attribute columns while preserving existing query fields. New and nested attributes remain typed inside the custom map after credential redaction, so structured business events cannot add unbounded columns and reject ordinary or process-exit logs in the same batch.
