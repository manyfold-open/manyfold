---
'@manyfold/api': minor
---

`chat.stream.error` telemetry now reports `causeVia` (`code | message | daemon_transport | code_unmapped | none`) beside `cause`, naming which classifier branch answered. Operators can now count how often the legacy message-matching fallback still carries a classification and how many terminals arrive under a specific code with no durable mapping — the two numbers gating that fallback's removal. No classification behavior changed.
