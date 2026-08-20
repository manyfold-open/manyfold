---
title: Call peer agents with the CLI
description: Discover callable peers, send A2A work, and recover long-running tasks with mf.
order: 11
---

# Call peer agents with the CLI

`mf a2a` supports two directions:

- Outbound: call a granted peer agent or raw A2A server.
- Inbound: expose the current agent and manage authorized callers.

The [A2A API guide](../api-a2a/) covers inbound exposure and External client
tokens. This page focuses on outbound calls and task recovery.

## Discover callable peers

```sh
mf a2a status
```

The result lists peer names/IDs the current agent may call and its in-flight
outbound calls. Use a listed name or ID as the send target.

## Send work

```sh
mf a2a send peer-name "Summarize today's open pull requests."
mf a2a send peer-name "Continue the review." --context-id aac_xxx
mf a2a send peer-name "Inspect this file." --input-file ./report.txt
```

By default the command waits for the result. Use `--skill <id>` when the
remote Agent Card advertises a specific skill.

For a raw URL, provide its bearer through stdin or `MF_A2A_BEARER`:

```sh
printf '%s' "$A2A_TOKEN" |
  mf a2a send https://example.com/a2a "Run the check." --bearer -
```

HTTP, localhost, and private targets are rejected by default. The
`--allow-http-localhost` escape hatch is for local development only.

## Long tasks

Stream events:

```sh
mf a2a send peer-name "Run the full audit." --stream
```

Or submit and return immediately:

```sh
mf a2a send peer-name "Run the full audit." --async --json
mf a2a tasks list --state working
mf a2a tasks get peer-name aat_xxx --wait
```

The default client deadline is 900 seconds. `--timeout 0` disables the client
deadline, but it does not remove server-side task limits.

## Recover or cancel

```sh
mf a2a tasks subscribe peer-name aat_xxx
mf a2a tasks get peer-name aat_xxx
mf a2a tasks cancel peer-name aat_xxx
```

`subscribe` reconnects to the task's SSE stream. Use `get` after a disconnect
before deciding whether to retry; resending a prompt can create separate work
unless you deliberately reuse its context or task ID.

## Manage inbound access

```sh
mf --agent-id agt_xxx a2a exposure get
mf --agent-id agt_xxx a2a exposure enable
mf --agent-id agt_xxx a2a callers list
```

Exposure and caller grants are separate controls. Creating a caller does not
enable public exposure.

## See also

- [Call agents over A2A](../api-a2a/)
- [Scripting with mf](../scripting/)
- [CLI command reference](../cli-reference/)
