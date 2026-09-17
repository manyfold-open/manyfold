---
version: '3.0.3'
date: '2026-09-17'
---

Executions now own their temporary settings and isolated process tree until
cleanup finishes. Cancellation stops the full process tree and removes the
temporary settings before the final execution acknowledgment on every
supported platform.
