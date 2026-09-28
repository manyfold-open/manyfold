---
'@manyfold/api': minor
---

A sandbox's active hours now accrue from the same power state that holds its concurrent-sandbox slot: while its daemon is heartbeating, a sandbox that sprites.dev misreports as asleep is metered as running instead of holding a slot for free. A sandbox kept running this way is also sampled on the fast cadence, so metering stops within seconds of the daemon going quiet.
