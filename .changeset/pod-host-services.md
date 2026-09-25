---
'@manyfold/api': minor
'@manyfold/web': minor
'@manyfold/cli': minor
---

OpenClaw and Hermes run on cloud computers, and the create flow offers a cloud computer to install them on. The framework goes onto the computer's volume and its gateway becomes a service of the computer's daemon, which starts it, restarts it with a backoff after a crash, and keeps it running across the daemon's own updates; each framework gets its own address on the cluster's ingress, and its runtime is ready once the gateway answers its health check. Changing credentials or environment variables, toggling the OpenClaw Control UI and changing the framework version rewrite the service and restart it; removing the runtime stops the service and withdraws its address. The first agent of an OpenClaw or Hermes runtime is the gateway's built-in profile, as on a sandbox. The daemon advertises `services.v1` (service upsert, start, stop, delete and list) under the container startup method. The runtime host image moves to Node 24, which current OpenClaw requires.

Also fixed on every runtime: an OpenClaw turn no longer fails with "model not found" when OpenClaw lists the agent's model with its provider prefix; a Hermes install pinned to a release runs that release's installer; a failed Hermes version change keeps the working install instead of removing it; and the daemon hands Hermes a FIFO for its output, since under the compiled CLI Hermes read its stdout as closed and turns stalled at the ACP handshake.
