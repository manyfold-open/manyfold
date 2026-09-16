---
'@manyfold/web': patch
'@manyfold/admin': patch
---

Keep browser telemetry working after DOM-bearing Web Vitals, preserve application errors while bounding repeated global-error reports, and flush pending reports when a page is hidden. Dashboard failures now remain readable when a popup loses DOM access, and failed model refreshes show their existing error without a second unhandled rejection.
