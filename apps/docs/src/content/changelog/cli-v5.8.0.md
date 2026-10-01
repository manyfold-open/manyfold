---
version: '5.8.0'
date: '2026-10-01'
---

Errors now say what went wrong and exit with the code their kind promises,
every list prints a table with a header, and agent-to-agent calls carry
files and stream to the end from the standalone binary.

A mistake on the command line exits `5` with `invalid_usage` wherever the
command notices it, and an `@file` that cannot be read names its flag.
`mf channels test` and `mf channels register` exit `1` when the check fails,
as `mf doctor` does. A plan limit or quota no longer points at your token's
scopes: each code gets a hint with the numbers, such as `2 of 2 on the Free
plan`, and what to free up, and `--json` passes its `details` through.

Every list command prints an aligned table with a header row; `--json` is
unchanged and stays the format for scripts. `--help` marks the options a
command cannot run without, `mf channels create --config` defaults to `{}`,
and the new `mf channels sessions get` shows one channel session, archived
ones included. Switching to a deleted session now fails with a hint instead
of reporting success.

`mf a2a send --stream` no longer hangs in the standalone `mf`, and
`--input-file` reaches a Manyfold peer, which reads the file in its
workspace. A2A failures exit by kind: an endpoint that does not resolve or
answer exits `2` and names it, a peer you hold no grant for exits `4`, and a
refusal the peer names, such as a sandbox CLI too old for files, keeps its
code and hint. Adding a caller that already has a grant suggests
`--replace-existing`.
