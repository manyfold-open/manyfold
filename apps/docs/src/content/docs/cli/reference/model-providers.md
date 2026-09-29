---
title: "mf model-providers"
description: "List the model providers agents can be created with"
order: 12
---
**Usage:** `mf model-providers [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf model-providers list`](#mf-model-providers-list) | List your saved and Manyfold managed model providers; --framework checks each against a framework |

## `mf model-providers list`

List your saved and Manyfold managed model providers; --framework checks each against a framework

**Usage:** `mf model-providers list [options]`

**Aliases:** `ls`

**Options**

| Options | Purpose |
| --- | --- |
| `--framework <framework>` | coding framework to check each provider against One of: `claude-code`, `codex`, `gemini-cli`, `pi`, `antigravity-cli`. |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
