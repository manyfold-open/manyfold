---
'@manyfold/api': minor
---

A dropped database connection no longer takes the API process down through work that nothing waits on. Several background jobs started a database call without awaiting it: the sandbox power-sync tick, which runs every 1.5 seconds, the automation scheduler, the export and deletion sweeps, a forced daemon disconnect, the sign-in reconcile after a terminal closes, the ready-service refresh and the pod-host cleanup. When the pooler dropped connections, the call rejected with nobody to handle it, and the API exits on an unhandled rejection. Those jobs now log the failure and keep running. As a backstop, an unhandled rejection that postgres.js raised for a lost connection (`CONNECTION_CLOSED`, `CONNECTION_ENDED`, `CONNECTION_DESTROYED` or `CONNECT_TIMEOUT`) is reported as a `process.unhandled_rejection` event with `outcome: recovered` instead of ending the process; every other unhandled rejection is still fatal.
