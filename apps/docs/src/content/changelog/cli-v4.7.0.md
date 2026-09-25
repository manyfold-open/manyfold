---
version: '4.7.0'
date: '2026-09-25'
---

A daemon now needs Manyfold CLI 4.6.1 or newer. The API refuses registration,
heartbeats and connections from an older daemon, and `mf doctor` and the
daemon's refusal message name that minimum. A daemon that launchd or systemd
starts against the official API updates itself once it is idle; one started
by hand needs `mf update` and a restart.

The runner no longer admits a framework home directory outside the core set
by default. The platform registers such a framework's home with the runner
before a turn, so its agents keep working.
