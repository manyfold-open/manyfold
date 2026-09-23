---
version: '4.3.0'
date: '2026-09-23'
---

`mf doctor` finds what is wrong with a machine's mf setup and says how to fix
each problem. It checks the install and every profile on the machine: the
sign-in and API (an unreachable deployment, a URL that is not the API, a
rejected token and why) and the daemon (its registration, process and
autostart unit, a daemon still running an older binary than the one on disk,
and why it is offline). It exits 1 when a check fails, and `mf doctor --json`
gives the same report for scripts. A daemon the API turns away (a revoked,
deleted or too-old machine) no longer reconnects every second: it logs why and
retries less often, down to once every 15 minutes. Rejected heartbeats are
logged, autostart units keep `MF_CONFIG_DIR`, an invalid `MF_HTTP_TIMEOUT` is
an error, and `mf daemon status` checks the registration the way
`mf daemon start` does.
