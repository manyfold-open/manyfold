---
'@manyfold/api': minor
---

A service framework prepared on a sandbox or a cloud computer before its first agent now works end to end. An OpenClaw runtime with no model provider yet starts its gateway without one; before, its setup failed on "cannot resolve base_url". The gateway's built-in profile is left for the first agent that joins instead of being listed as an agent of its own, which OpenClaw would then refuse to delete, leaving the runtime undeletable. Deleting a service framework's runtime now also removes its services and the machine's route to it; before, only the record went and the service kept running.
