---
'@manyfold/api': minor
---

Bringing up a sandbox's daemon now gives a registered daemon a moment to reconnect by itself after the sandbox thaws, as it already did after an explicit wake. Before, when the sandbox already read as running, the daemon was restarted even if it had just reconnected, which ended the work it was still carrying.
