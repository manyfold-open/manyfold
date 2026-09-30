---
title: "mf mcp"
description: "Manage an agent's MCP servers"
order: 16
---
**用法:** `mf mcp [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
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

**用法:** `mf mcp list [options]`

**Alias:** `ls`

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-id <id>` | agent whose servers these are (defaults to $MF_AGENT_ID) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf mcp add`

Add an MCP server to an agent: its URL, or after -- the command it runs as

**用法:** `mf mcp add [options] <name> [target...]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<name>` |  |
| `[target...]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-id <id>` | agent whose servers these are (defaults to $MF_AGENT_ID) |
| `--scope <scope>` | config scope it goes in (default: the framework's first; mf mcp list names them) |
| `--header <header>` | "Name: value" header for a server reached by URL (repeatable) 默认值: ``. |
| `--env <pair>` | NAME=value for a server run as a command (repeatable) 默认值: ``. |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf mcp install`

Install a server from your MCP library or the platform's catalog on an agent

**用法:** `mf mcp install [options] <key>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<key>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--as <name>` | its name in the agent config (default: its key) |
| `--agent-id <id>` | agent whose servers these are (defaults to $MF_AGENT_ID) |
| `--scope <scope>` | config scope it goes in (default: the framework's first; mf mcp list names them) |
| `--header <header>` | "Name: value" header for a server reached by URL (repeatable); fills in the entry's 默认值: ``. |
| `--env <pair>` | NAME=value for a server run as a command (repeatable); fills in the entry's 默认值: ``. |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf mcp remove`

Remove an MCP server from an agent's config

**用法:** `mf mcp remove [options] <name>`

**Alias:** `rm`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<name>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-id <id>` | agent whose servers these are (defaults to $MF_AGENT_ID) |
| `--scope <scope>` | the config scope to remove it from |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf mcp pull`

Read the MCP servers on the agent's machine into Manyfold (ones added there, e.g. with claude mcp add, that a push would replace)

**用法:** `mf mcp pull [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-id <id>` | agent whose servers these are (defaults to $MF_AGENT_ID) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf mcp push`

Write the agent's MCP servers into its machine's config now

**用法:** `mf mcp push [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--agent-id <id>` | agent whose servers these are (defaults to $MF_AGENT_ID) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf mcp catalog`

The MCP servers the platform offers

**用法:** `mf mcp catalog [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf mcp catalog list`](#mf-mcp-catalog-list) | List catalog MCP servers |
| [`mf mcp catalog get`](#mf-mcp-catalog-get) | Show a catalog MCP server: what installing it adds |

### `mf mcp catalog list`

List catalog MCP servers

**用法:** `mf mcp catalog list [options]`

**Alias:** `ls`

**Option**

| Option | 用途 |
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

**用法:** `mf mcp catalog get [options] <slug>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<slug>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf mcp library`

Your MCP library: servers kept to install on any agent

**用法:** `mf mcp library [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf mcp library list`](#mf-mcp-library-list) | List the servers in your MCP library |
| [`mf mcp library create`](#mf-mcp-library-create) | Keep a server in your library: its URL, or after -- the command it runs as |
| [`mf mcp library update`](#mf-mcp-library-update) | Change a server in your library: a new URL or command replaces how it is reached; --header / --env add or change values |
| [`mf mcp library delete`](#mf-mcp-library-delete) | Delete a server from your library (agents it was installed on keep their copy) |

### `mf mcp library list`

List the servers in your MCP library

**用法:** `mf mcp library list [options]`

**Alias:** `ls`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf mcp library create`

Keep a server in your library: its URL, or after -- the command it runs as

**用法:** `mf mcp library create [options] <key> [target...]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<key>` |  |
| `[target...]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--name <name>` | display name (default: the key) |
| `--description <text>` | what it is for |
| `--header <header>` | "Name: value" header for a server reached by URL (repeatable) 默认值: ``. |
| `--env <pair>` | NAME=value for a server run as a command (repeatable) 默认值: ``. |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf mcp library update`

Change a server in your library: a new URL or command replaces how it is reached; --header / --env add or change values

**用法:** `mf mcp library update [options] <key> [target...]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<key>` |  |
| `[target...]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--name <name>` | new display name |
| `--description <text>` | new description |
| `--header <header>` | "Name: value" header for a server reached by URL (repeatable) 默认值: ``. |
| `--env <pair>` | NAME=value for a server run as a command (repeatable) 默认值: ``. |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

### `mf mcp library delete`

Delete a server from your library (agents it was installed on keep their copy)

**用法:** `mf mcp library delete [options] <key>`

**Alias:** `rm`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<key>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `-y, --yes` | confirm deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
