---
version: '3.0.2'
date: '2026-09-17'
---

Daemon startup now logs before inspecting the user's shell and bounds every
shell probe to three seconds. A timed-out probe and its process tree are stopped,
while the current `PATH` and the directory containing the running executable
remain available as fallbacks.

On Windows, temporary file-sharing denial no longer makes ownership metadata
replacement fail immediately. The CLI retries only the expected replacement
errors for a bounded interval, keeps the previous target intact, and retains
the kernel ownership lock throughout publication. Persistent permission errors
still stop startup with an error.

An execution now remains active until its runtime-auth profile lease has been
released. Immediate work on the same profile can acquire the lock after the
first execution completes, including when spawning, streaming, cancellation,
or cleanup fails.

Darwin binaries are finalized with an ad-hoc signature and verified before and
after packaging. This confirms artifact integrity and the `ai.manyfold.mf`
identifier; it does not provide Developer ID notarization or guarantee that
macOS privacy grants survive an upgrade.
