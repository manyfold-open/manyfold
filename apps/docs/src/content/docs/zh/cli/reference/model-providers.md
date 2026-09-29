---
title: "mf model-providers"
description: "List the model providers agents can be created with"
order: 12
---
**用法:** `mf model-providers [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf model-providers list`](#mf-model-providers-list) | List your saved and Manyfold managed model providers; --framework checks each against a framework |

## `mf model-providers list`

List your saved and Manyfold managed model providers; --framework checks each against a framework

**用法:** `mf model-providers list [options]`

**Alias:** `ls`

**Option**

| Option | 用途 |
| --- | --- |
| `--framework <framework>` | coding framework to check each provider against 可选值: `claude-code`, `codex`, `gemini-cli`, `pi`, `antigravity-cli`. |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
