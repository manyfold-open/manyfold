---
title: "mf a2a"
description: "Talk to A2A servers and manage this agent exposure and callers"
order: 15
---
**Usage:** `mf a2a [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf a2a exposure`](#mf-a2a-exposure) | Manage this agent's hosted A2A exposure |
| [`mf a2a callers`](#mf-a2a-callers) | Manage callers authorized to invoke this agent |
| [`mf a2a card`](#mf-a2a-card) | Fetch and print an Agent Card |
| [`mf a2a status`](#mf-a2a-status) | Show callable peers and in-flight outbound calls |
| [`mf a2a send`](#mf-a2a-send) | Send a message to a granted peer (name/id from `mf a2a status`) or a raw A2A url |
| [`mf a2a tasks`](#mf-a2a-tasks) | Track A2A tasks |

## `mf a2a exposure`

Manage this agent's hosted A2A exposure

**Usage:** `mf a2a exposure [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf a2a exposure get`](#mf-a2a-exposure-get) | Show hosted A2A exposure and public endpoints |
| [`mf a2a exposure enable`](#mf-a2a-exposure-enable) | Expose this agent as an A2A server |
| [`mf a2a exposure disable`](#mf-a2a-exposure-disable) | Stop exposing this agent as an A2A server |

### `mf a2a exposure get`

Show hosted A2A exposure and public endpoints

**Usage:** `mf a2a exposure get [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

### `mf a2a exposure enable`

Expose this agent as an A2A server

**Usage:** `mf a2a exposure enable [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

### `mf a2a exposure disable`

Stop exposing this agent as an A2A server

**Usage:** `mf a2a exposure disable [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

## `mf a2a callers`

Manage callers authorized to invoke this agent

**Usage:** `mf a2a callers [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf a2a callers list`](#mf-a2a-callers-list) | List peer and external callers |
| [`mf a2a callers add`](#mf-a2a-callers-add) | Add an external client or peer agent caller |
| [`mf a2a callers revoke`](#mf-a2a-callers-revoke) | Revoke an A2A caller grant |

### `mf a2a callers list`

List peer and external callers

**Usage:** `mf a2a callers list [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

### `mf a2a callers add`

Add an external client or peer agent caller

**Usage:** `mf a2a callers add [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--external` | create an External client bearer |
| `--caller-agent-id <id>` | authorize a Manyfold peer agent |
| `--name <name>` | External client label |
| `--expires-in-days <days>` | positive integer; omit for no expiry |
| `--replace-existing` | replace an existing grant for the peer agent |
| `--json` | emit JSON (includes a new External client token) |
| `-h, --help` | display help for command |

### `mf a2a callers revoke`

Revoke an A2A caller grant

**Usage:** `mf a2a callers revoke [options] <tokenId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<tokenId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `-y, --yes` | confirm revocation |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

## `mf a2a card`

Fetch and print an Agent Card

**Usage:** `mf a2a card [options] <url>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<url>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--bearer <token>` | bearer token for a raw url target ("-" reads stdin; falls back to $MF_A2A_BEARER) |
| `--json` | emit raw A2A JSON instead of a human summary |
| `--allow-http-localhost` | allow http:// and localhost/private targets (local dev only) |
| `-h, --help` | display help for command |

## `mf a2a status`

Show callable peers and in-flight outbound calls

**Usage:** `mf a2a status [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

## `mf a2a send`

Send a message to a granted peer (name/id from `mf a2a status`) or a raw A2A url

**Usage:** `mf a2a send [options] <target> <prompt>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<target>` |  |
| `<prompt>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--bearer <token>` | bearer token for a raw url target ("-" reads stdin; falls back to $MF_A2A_BEARER) |
| `--json` | emit raw A2A JSON instead of a human summary |
| `--allow-http-localhost` | allow http:// and localhost/private targets (local dev only) |
| `--context-id <id>` | reuse an A2A context (conversation) |
| `--task-id <id>` | continue an existing task |
| `--skill <id>` | select a remote skill by id |
| `--input-file <path>` | attach a file as an A2A file part |
| `--stream` | stream status + artifact chunks (SSE) |
| `--async` | submit and return a task id immediately (poll with `mf a2a tasks get`) |
| `--timeout <seconds>` | client deadline in seconds (0 disables; default 900) |
| `-h, --help` | display help for command |

## `mf a2a tasks`

Track A2A tasks

**Usage:** `mf a2a tasks [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf a2a tasks list`](#mf-a2a-tasks-list) | List this agent's outbound A2A calls |
| [`mf a2a tasks get`](#mf-a2a-tasks-get) | Fetch a task by id (target = peer name/id or url) |
| [`mf a2a tasks cancel`](#mf-a2a-tasks-cancel) | Cancel a task by id |
| [`mf a2a tasks subscribe`](#mf-a2a-tasks-subscribe) | Resubscribe to a task SSE stream (reconnect) |

### `mf a2a tasks list`

List this agent's outbound A2A calls

**Usage:** `mf a2a tasks list [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--state <state>` | filter by state (e.g. working) |
| `--peer <agentId>` | filter by peer (target agent id) |
| `--json` | emit JSON |
| `-h, --help` | display help for command |

### `mf a2a tasks get`

Fetch a task by id (target = peer name/id or url)

**Usage:** `mf a2a tasks get [options] <target> <taskId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<target>` |  |
| `<taskId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--wait` | poll until the task reaches a terminal state |
| `--timeout <seconds>` | deadline for --wait (0 disables; default 900) |
| `--bearer <token>` | bearer token for a raw url target ("-" reads stdin; falls back to $MF_A2A_BEARER) |
| `--json` | emit raw A2A JSON instead of a human summary |
| `--allow-http-localhost` | allow http:// and localhost/private targets (local dev only) |
| `-h, --help` | display help for command |

### `mf a2a tasks cancel`

Cancel a task by id

**Usage:** `mf a2a tasks cancel [options] <target> <taskId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<target>` |  |
| `<taskId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--bearer <token>` | bearer token for a raw url target ("-" reads stdin; falls back to $MF_A2A_BEARER) |
| `--json` | emit raw A2A JSON instead of a human summary |
| `--allow-http-localhost` | allow http:// and localhost/private targets (local dev only) |
| `-h, --help` | display help for command |

### `mf a2a tasks subscribe`

Resubscribe to a task SSE stream (reconnect)

**Usage:** `mf a2a tasks subscribe [options] <target> <taskId>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<target>` |  |
| `<taskId>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--bearer <token>` | bearer token for a raw url target ("-" reads stdin; falls back to $MF_A2A_BEARER) |
| `--json` | emit raw A2A JSON instead of a human summary |
| `--allow-http-localhost` | allow http:// and localhost/private targets (local dev only) |
| `-h, --help` | display help for command |
