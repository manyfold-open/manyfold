---
'@manyfold/api': patch
'@manyfold/web': patch
---

Keep quota warnings pending until a connected client acknowledges them, revalidate current allowance before confirmation, and preserve delivery across API instances and reconnects.
