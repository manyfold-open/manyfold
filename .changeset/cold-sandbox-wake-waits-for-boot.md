---
'@manyfold/api': minor
---

A turn that wakes a sandbox from cold now gives its runner up to 90 seconds to boot and dial back in. Before, it waited 15 seconds and then tried to restart the runner while the machine was still booting. That could fail the turn with "not accepting commands" seconds before the runner came back.
