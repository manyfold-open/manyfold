---
version: '5.9.0'
date: '2026-10-01'
---

The Update Center comes to the terminal, usage reports print tables and
check their options, and an agent-to-agent call that the peer hands back as
still working is followed to its answer.

`mf updates` lists what the web's Update Center lists: the mf CLI and herdr
on your computers, sandboxes and cloud computers, each runtime's framework,
the CLIs a sandbox ships, and your agents' skills, with the version each is
on, the one it would go to, and whether it can run from here. `mf updates
apply` runs them in the Update Center's order, at most five computer updates
a minute, and reports each as updated, pending until the machine's sessions
finish, or failed. `mf updates versions` shows the versions you can install.
`mf sandbox list` shows each sandbox's CLI version and points at
`mf sandbox update` or `mf updates apply --kind cli` when one is behind.

`mf usage` prints tables, and on its own runs `summary`. The JSON is
unchanged but no longer the default: a script or agent that reads
`mf usage` output must pass `--json`. Options are checked before anything is
sent, and a bad one exits `5`: `--bucket` takes `hour` or `day`, `--limit` is
a whole number in range, and `--from` and `--to` take a date or a date and
time, read as UTC unless they name a zone. Inside an agent runtime,
`mf --account usage` reads the whole account. `mf mcp catalog list` and
`mf skills discover` check `--limit` the same way.

`mf a2a send` follows a task the peer hands back `working` at its blocking
limit and prints the answer when it finishes, within the same `--timeout`.
Past the deadline it exits `1` with the command that keeps following the
task. A task that ends `failed`, `canceled` or `rejected` prints its reason
and exits `1`.

`mf update` reports failures like every other command and takes `--json`: a
network failure exits `2` and names the host, and a bad `--channel` or `--to`
exits `5` before anything is fetched. A `401` for a token of the wrong kind
says the call needs a login session or a full-access token. A daemon update
that waits for its sessions now retries a failed download instead of giving
up, and a sandbox update the daemon defers completes; the runtimes page and
`mf sandbox update` show how many sessions it is waiting for.
