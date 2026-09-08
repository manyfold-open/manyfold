---
'@manyfold/api': patch
---

Make lazy daemon identity creation concurrency-safe so concurrent first turns reuse the same active credential.
