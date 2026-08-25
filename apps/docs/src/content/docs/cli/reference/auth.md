---
title: "mf auth"
description: "Authenticate and manage capabilities for the current identity"
order: 1
---
**Usage:** `mf auth [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf auth ensure`](#mf-auth-ensure) | Ensure the current identity has the requested capabilities |

## `mf auth ensure`

Ensure the current identity has the requested capabilities

**Usage:** `mf auth ensure [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--scopes <list>` | comma-separated grant scopes to ensure (e.g. channels:read,channels:edit) |
| `--for-agent <id>` | agent to ensure scopes for (defaults to --agent-id / $MF_AGENT_ID) |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
