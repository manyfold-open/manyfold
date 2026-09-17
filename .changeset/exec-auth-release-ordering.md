---
'@manyfold/cli': patch
---

Wait for runtime-auth profile cleanup before completing executions, so immediate same-profile work can acquire the released lock. Report cleanup failures without exposing credentials and retain execution ownership until cleanup finishes.
