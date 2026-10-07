---
'@manyfold/api': minor
---

Report an international WeChat channel as connected while its long polls end at the edge timeout, instead of leaving it in error and restarting it every 10 minutes. A getupdates HTTP 554 is now the same poll boundary as 524, and an edge connect timeout (HTTP 522/552) is retried in the poll loop; only three in a row put the channel in error.
