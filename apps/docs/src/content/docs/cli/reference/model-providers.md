---
title: "mf model-providers"
description: "List and test the model providers agents can be created with"
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
| [`mf model-providers test`](#mf-model-providers-test) | Test a provider again (id or name), which refreshes the models it can run |

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

## `mf model-providers test`

Test a provider again (id or name), which refreshes the models it can run

**Usage:** `mf model-providers test [options] <provider>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<provider>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--framework <framework>` | coding framework to check each provider against One of: `claude-code`, `codex`, `gemini-cli`, `pi`, `antigravity-cli`. |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
