---
'@manyfold/cli': minor
---

A daemon update that waits for its sessions to finish is no longer dropped when applying it fails once. Before, a deferred update whose release manifest or download timed out was given up silently, and the CLI stayed on the old version. The daemon now tries again twice, 15 seconds apart, and keeps refusing new sessions until the update lands or the third try fails.
