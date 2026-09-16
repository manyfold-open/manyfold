---
'@manyfold/api': patch
---

Isolate background telemetry scopes, stop collecting automatic HTTP breadcrumbs, and strip query and fragment data from Sentry requests, breadcrumbs and transaction spans before sending.
