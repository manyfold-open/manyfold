---
'@manyfold/api': minor
'@manyfold/web': minor
---

A sandbox's Runtimes section has a refresh button beside "+" that probes the sandbox for every framework on it now, through its daemon, instead of showing what the daemon last reported, which could be minutes old, or older while the sandbox slept. The probe wakes the sandbox; opening the page still only reads the last report. `POST /sandboxes/:id/detect-frameworks` takes `{ "probe": true }` for this, and Detect frameworks left the sandbox's "…" menu.
