---
'@manyfold/api': major
'@manyfold/cli': major
'@manyfold/web': minor
'@manyfold/admin': minor
---

One machine is one host, one host has one daemon, and a runtime is one
framework on one host. Every self-owned computer, stateful sandbox and cloud
computer now runs a single `mf daemon` that carries all of its frameworks; the
platform-managed runner runtimes that used to shadow each sandbox and pod are
gone, and a host's daemon registers onto the host itself. Keep-alive moves from
the runtime to the sandbox: the switch keeps the machine awake
(`PATCH /sandboxes/:id/keep-awake`; `/agent-runtimes/:id/keep-alive` is
removed), and stopping is host-level (`POST /sandboxes/:id/stop`;
`POST /agents/:id/stop` is removed). Runtime providers replace sprites accounts
and Kubernetes clusters in Admin (`/admin/runtime-providers`); sandboxes, pod
hosts and agents are placed with `providerId` (`accountId` / `clusterId` are
gone). Agent, runtime, sandbox and host summaries expose the host they live on
(`hostId`, `hostName`, `powerState`, `daemonOnline`, `keepAwake`) and a derived
`availability` instead of copied sprite / pod fields, agent status is the
agent's own lifecycle (`pending` / `ready` / `failed`) and runtime status the
install state (`installing` / `ready` / `failed`); the sprite-status stream
emits host-status events. Daemon protocol: the register response no longer
carries `runtimes`, the welcome frame's `runtimeIds` lists the runtimes on the
host, and the daemon's local stores are scoped by the host id. CLI: `mf agent
create --account-id` becomes `--provider-id`; `mf runtime get`, `mf agent get`
and `mf daemon status` print the host, provider, power state and availability.
