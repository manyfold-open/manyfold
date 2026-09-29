---
'@manyfold/api': minor
---

A sandbox kept awake is now held by Manyfold itself, which renews the hold from the API, instead of by a loop running inside the sandbox. Switching keep-awake off lets a running sandbox go at once, and never wakes a sleeping one to do it. Stopping a sandbox turns keep-awake off, a sleeping one included, so it is not woken again. Sandbox task lists show the keep-awake hold as Manyfold's, and it cannot be deleted there.
