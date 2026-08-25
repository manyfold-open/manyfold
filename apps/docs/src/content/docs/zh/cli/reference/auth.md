---
title: "mf auth"
description: "Authenticate and manage capabilities for the current identity"
order: 1
---
**用法:** `mf auth [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf auth ensure`](#mf-auth-ensure) | Ensure the current identity has the requested capabilities |

## `mf auth ensure`

Ensure the current identity has the requested capabilities

**用法:** `mf auth ensure [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--scopes <list>` | comma-separated grant scopes to ensure (e.g. channels:read,channels:edit) |
| `--for-agent <id>` | agent to ensure scopes for (defaults to --agent-id / $MF_AGENT_ID) |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
