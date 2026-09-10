---
'@manyfold/api': patch
---

Upgrading a sandbox's mf CLI now restarts the sprite runner onto the installed binary. The runner is a long-lived process with no supervisor, so it kept running — and reporting — the build it was started with: after an upgrade the sandbox showed the new version while the runtime page still asked for a CLI update, because every capability check reads the runner's own heartbeat. A runner with live exec or terminal sessions is left alone rather than interrupted; the outcome is logged either way.
