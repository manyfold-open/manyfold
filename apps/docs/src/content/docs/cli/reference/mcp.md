---
title: "mf mcp"
description: "Manage an agent's MCP servers"
order: 16
---
**Usage:** `mf mcp [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf mcp list`](#mf-mcp-list) | List an agent's MCP servers, by config scope |
| [`mf mcp add`](#mf-mcp-add) | Add an MCP server to an agent: its URL, or after -- the command it runs as |
| [`mf mcp install`](#mf-mcp-install) | Install a server from your MCP library or the platform's catalog on an agent |
| [`mf mcp remove`](#mf-mcp-remove) | Remove an MCP server from an agent's config |
| [`mf mcp pull`](#mf-mcp-pull) | Read the MCP servers on the agent's machine into Manyfold (ones added there, e.g. with claude mcp add, that a push would replace) |
| [`mf mcp push`](#mf-mcp-push) | Write the agent's MCP servers into its machine's config now |
| [`mf mcp catalog`](#mf-mcp-catalog) | The MCP servers the platform offers |
| [`mf mcp library`](#mf-mcp-library) | Your MCP library: servers kept to install on any agent |

## `mf mcp list`

List an agent's MCP servers, by config scope

**Usage:** `mf mcp list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-id <id>` | agent whose servers these are (defaults to $MF_AGENT_ID) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf mcp add`

Add an MCP server to an agent: its URL, or after -- the command it runs as

**Usage:** `mf mcp add [options] <name> [target...]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<name>` |  |
| `[target...]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-id <id>` | agent whose servers these are (defaults to $MF_AGENT_ID) |
| `--scope <scope>` | config scope it goes in (default: the framework's first; mf mcp list names them) |
| `--header <header>` | "Name: value" header for a server reached by URL (repeatable) Default: ``. |
| `--env <pair>` | NAME=value for a server run as a command (repeatable) Default: ``. |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf mcp install`

Install a server from your MCP library or the platform's catalog on an agent

**Usage:** `mf mcp install [options] <key>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<key>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--as <name>` | its name in the agent config (default: its key) |
| `--agent-id <id>` | agent whose servers these are (defaults to $MF_AGENT_ID) |
| `--scope <scope>` | config scope it goes in (default: the framework's first; mf mcp list names them) |
| `--header <header>` | "Name: value" header for a server reached by URL (repeatable); fills in the entry's Default: ``. |
| `--env <pair>` | NAME=value for a server run as a command (repeatable); fills in the entry's Default: ``. |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf mcp remove`

Remove an MCP server from an agent's config

**Usage:** `mf mcp remove [options] <name>`

**Aliases:** `rm`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<name>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-id <id>` | agent whose servers these are (defaults to $MF_AGENT_ID) |
| `--scope <scope>` | the config scope to remove it from |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf mcp pull`

Read the MCP servers on the agent's machine into Manyfold (ones added there, e.g. with claude mcp add, that a push would replace)

**Usage:** `mf mcp pull [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-id <id>` | agent whose servers these are (defaults to $MF_AGENT_ID) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf mcp push`

Write the agent's MCP servers into its machine's config now

**Usage:** `mf mcp push [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--agent-id <id>` | agent whose servers these are (defaults to $MF_AGENT_ID) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf mcp catalog`

The MCP servers the platform offers

**Usage:** `mf mcp catalog [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf mcp catalog list`](#mf-mcp-catalog-list) | List catalog MCP servers |
| [`mf mcp catalog get`](#mf-mcp-catalog-get) | Show a catalog MCP server: what installing it adds |

### `mf mcp catalog list`

List catalog MCP servers

**Usage:** `mf mcp catalog list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--q <query>` | search query |
| `--category <id>` | only this category |
| `--sort <order>` | 'featured' (default) or 'latest' |
| `--cursor <cursor>` | opaque cursor from the previous page |
| `--limit <n>` | page size (1-100, default 100) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf mcp catalog get`

Show a catalog MCP server: what installing it adds

**Usage:** `mf mcp catalog get [options] <slug>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<slug>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf mcp library`

Your MCP library: servers kept to install on any agent

**Usage:** `mf mcp library [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf mcp library list`](#mf-mcp-library-list) | List the servers in your MCP library |
| [`mf mcp library create`](#mf-mcp-library-create) | Keep a server in your library: its URL, or after -- the command it runs as |
| [`mf mcp library update`](#mf-mcp-library-update) | Change a server in your library: a new URL or command replaces how it is reached; --header / --env add or change values |
| [`mf mcp library delete`](#mf-mcp-library-delete) | Delete a server from your library (agents it was installed on keep their copy) |

### `mf mcp library list`

List the servers in your MCP library

**Usage:** `mf mcp library list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf mcp library create`

Keep a server in your library: its URL, or after -- the command it runs as

**Usage:** `mf mcp library create [options] <key> [target...]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<key>` |  |
| `[target...]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--name <name>` | display name (default: the key) |
| `--description <text>` | what it is for |
| `--header <header>` | "Name: value" header for a server reached by URL (repeatable) Default: ``. |
| `--env <pair>` | NAME=value for a server run as a command (repeatable) Default: ``. |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf mcp library update`

Change a server in your library: a new URL or command replaces how it is reached; --header / --env add or change values

**Usage:** `mf mcp library update [options] <key> [target...]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<key>` |  |
| `[target...]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--name <name>` | new display name |
| `--description <text>` | new description |
| `--header <header>` | "Name: value" header for a server reached by URL (repeatable) Default: ``. |
| `--env <pair>` | NAME=value for a server run as a command (repeatable) Default: ``. |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf mcp library delete`

Delete a server from your library (agents it was installed on keep their copy)

**Usage:** `mf mcp library delete [options] <key>`

**Aliases:** `rm`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<key>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `-y, --yes` | confirm deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
