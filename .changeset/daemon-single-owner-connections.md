---
'@manyfold/cli': patch
'@manyfold/api': patch
---

Keep one daemon process per profile, preserve the current owner's PID and control socket during concurrent starts or cleanup, and recover ownership after a crash. Ignore obsolete WebSocket callbacks, keep reconnect attempts single-flight, and preserve new RPC cancellation handlers when older connections finish. Include optional process identity and complete hello records for diagnosing connection churn. Existing duplicate foreground processes should be stopped before updating and restarting the same profile.
