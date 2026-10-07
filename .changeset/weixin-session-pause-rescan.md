---
'@manyfold/api': minor
---

A re-scanned WeChat channel reconnects right away instead of waiting out the rest of the hour-long pause its expired session started, and a successful Register ends that pause too. While a session stays expired, restarting the channel no longer sends the gateway a stop request with the dead token.
