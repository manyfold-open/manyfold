---
title: Manage runtimes with the CLI
description: Inspect runtimes, manage hosted agents, and control runtime user interfaces.
order: 6
---
A runtime is the execution environment carrying one or more agents. Use
`mf runtime` to inspect that environment and manage runtime-level services.

## Inspect or remove a runtime

```sh
mf runtime list
mf runtime get art_xxx
```

Runtime deletion tears down the underlying sprite or pod and cascades to its
hosted agents. Confirm the runtime ID, back up important agents, and inspect
`mf runtime get` before deleting. The command executes immediately without a
confirmation prompt:

```sh
mf runtime delete art_xxx
```

`--json` is available for automation.

## Manage hosted framework agents

Multi-agent runtimes can host additional framework agents:

```sh
mf runtime agents list art_xxx
mf runtime agents add art_xxx --name reviewer --model gpt-5.6
mf runtime agents add art_xxx --name clone --clone-from agt_source
mf runtime agents remove agt_xxx --yes
```

The remove command takes an **agent ID**, not a runtime ID. Coding agents can
also set `--workspace <path>`. Removal is irreversible and requires the
explicit `--yes` option.

## Control UI

Supported runtimes can expose a control UI sidecar:

```sh
mf runtime control-ui enable art_xxx
mf runtime control-ui get-url art_xxx
mf runtime control-ui disable art_xxx
```

Treat the returned URL as temporary access information. Do not publish it in
logs or public tickets.

## Hermes dashboard

Hermes runtimes have a separate dashboard lifecycle:

```sh
mf runtime dashboard enable art_xxx
mf runtime dashboard disable art_xxx
```

These commands are Hermes-only; they fail for incompatible runtime/framework
combinations.

## See also

- [Manage agents with the CLI](/docs/cli/agents/)
- [Register a self-owned computer](/docs/local-daemons/)
- [CLI command reference](/docs/cli/reference/)
