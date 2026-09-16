---
'@manyfold/web': patch
'@manyfold/admin': patch
---

Scrub retained navigation URLs and query/fragment attributes from browser telemetry with a shared Web/Admin policy. Apply it to individual spans and final event/transaction envelopes while retaining routes, attribution-independent query parameters and performance timings.
