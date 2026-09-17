---
'@manyfold/api': patch
---

Keep WeChat inbound polling active when getupdates returns HTTP 524, preserving the cursor and initial-sync baseline. Fast edge timeouts use a short cancellable delay; other HTTP, network and expired-session failures retain their existing behavior.
