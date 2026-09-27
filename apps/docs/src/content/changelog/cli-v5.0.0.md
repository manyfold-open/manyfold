---
version: '5.0.0'
date: '2026-09-27'
---

One machine is one host, one host runs one `mf daemon`, and a runtime is
one framework on one host. A daemon registers onto its host and scopes its
local stores by the host id; on a stateful sandbox or a cloud computer the
platform brings the daemon up itself.

`mf daemon status` prints the host id, whether the machine is a self-owned
computer or hosted, the host status and whether the daemon is online, and
lists each runtime with its install status and availability.
`mf runtime get` and `mf agent get` print availability, host, provider and
power state in place of the sprite, namespace and ingress lines, and
`mf sandbox storage-usage` shows each machine's power state.

`mf agent create --account-id` becomes `--provider-id` (admin only), which
places a new sandbox on a runtime provider. `mf runtime delete` no longer
tears down the machine or its agents: it is refused while agents still use
the runtime.
