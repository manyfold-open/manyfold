---
version: '0.18.0'
date: '2026-07-14'
---

## CLI 0.18.0 — One-command setup and safer automation

The CLI gains guided machine onboarding, classified failures, stable exit
codes, grouped help, and safer daemon lifecycle behavior.

### Highlights

- **`mf setup`.** Sign in, issue a machine token, register the host, install
  autostart, and wait for daemon health in one command.
- **Stable script failures.** Network, auth, not-found, invalid-request, and
  other failures have distinct exit codes and structured JSON errors.
- **Safer token input.** `--token -` reads from stdin so secrets do not need to
  appear in argv.
- **Idle daemon auto-update.** Official init-managed daemons check every six
  hours and install only while idle; busy sessions are never interrupted.
- **Offline daemon status.** A local protected control socket reports daemon
  version, connectivity, and active sessions without contacting the cloud.
- **Bounded logs and strict state.** Logs rotate, secret-bearing state writes
  are atomic, and corrupt configuration fails with an actionable message.
