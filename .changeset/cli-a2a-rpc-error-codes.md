---
'@manyfold/cli': minor
---

When a Manyfold A2A server refuses a call and names the cause, `mf a2a` now reports that cause instead of `cli_error`. The error shows the code (for example `SANDBOX_CLI_TOO_OLD` for a peer sandbox whose CLI predates files, or `delegation_limit`), and the command prints the matching hint and exits with the code for that kind of failure.
