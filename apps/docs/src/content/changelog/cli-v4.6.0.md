---
version: '4.6.0'
date: '2026-09-25'
---

The daemon knows a new startup method, `container`, which the Manyfold pod
host image sets. Under it the daemon accepts updates from the platform and
restarts into the new version, while its own auto-update stays off.

In that mode the daemon also keeps the services of the frameworks installed on
the machine running: it starts them, restarts one that crashes, with a
backoff, and keeps them running across its own updates.

Hermes turns carried by the daemon no longer stall at startup.
