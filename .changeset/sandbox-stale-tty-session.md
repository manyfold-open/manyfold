---
'@manyfold/api': minor
---

A program left running in a sandbox terminal from before terminals moved to the sandbox's daemon no longer keeps that sandbox running for good. The exec-session reaper now ends a terminal (TTY) exec session once it is more than six hours old, even while it is still drawing to the screen. An operator's own console session on a sandbox is ended the same way. The reaper's log line and telemetry say whether a session was ended for being idle or for its age.
