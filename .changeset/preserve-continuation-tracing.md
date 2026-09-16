---
'@manyfold/api': patch
---

Preserve trace recording for detached chat work by creating a real OpenTelemetry root span instead of an unsampled synthetic parent. Retain the initiating identity, correlation attributes and original task completion ordering.
