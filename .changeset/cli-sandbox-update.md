---
'@manyfold/cli': minor
---

`mf sandbox update <sandbox>` updates the Manyfold CLI on a sandbox, as the web's Update Center does: to its channel's latest, or `--to <version>` for a particular build (dev builds included, checked against the versions offered before anything is sent). It prints the version it went from and to, says when a busy sandbox will take the update, and when the sandbox already runs its channel's latest, lists the newer builds `--to` can install. A file operation that fails because a sandbox's CLI is too old (`SANDBOX_CLI_TOO_OLD`) now points at this command instead of "contact support".
