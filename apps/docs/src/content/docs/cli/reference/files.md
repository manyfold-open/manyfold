---
title: "mf files"
description: "Read/write files on an agent runtime"
order: 9
---
**Usage:** `mf files [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf files roots`](#mf-files-roots) | List available file roots for an agent |
| [`mf files list`](#mf-files-list) | List directory entries on an agent |
| [`mf files stat`](#mf-files-stat) | Show file metadata |
| [`mf files read`](#mf-files-read) | Read file contents (to stdout or --output) |
| [`mf files write`](#mf-files-write) | Write file contents from --content or --file |
| [`mf files upload`](#mf-files-upload) | Upload a local file to an agent (remotePath defaults to the file name) |
| [`mf files download`](#mf-files-download) | Download a file from an agent (localPath defaults to the file name, - for stdout) |
| [`mf files mkdir`](#mf-files-mkdir) | Create a directory on an agent |
| [`mf files mv`](#mf-files-mv) | Move or rename a path on an agent |
| [`mf files rm`](#mf-files-rm) | Remove a file or directory on an agent |

## `mf files roots`

List available file roots for an agent

**Usage:** `mf files roots [options] [agentId]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[agentId]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf files list`

List directory entries on an agent

**Usage:** `mf files list [options] [agentIdOrPath] [path]`

**Aliases:** `ls`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--root <rootId>` | root id (default: workspace) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf files stat`

Show file metadata

**Usage:** `mf files stat [options] [agentIdOrPath] [path]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--root <rootId>` | root id |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

## `mf files read`

Read file contents (to stdout or --output)

**Usage:** `mf files read [options] [agentIdOrPath] [path]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--root <rootId>` | root id |
| `--output <localPath>` | write to this local file instead of stdout |
| `-h, --help` | display help for command |

## `mf files write`

Write file contents from --content or --file

**Usage:** `mf files write [options] [agentIdOrPath] [path]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--content <data>` | inline content (string) |
| `--file <localPath>` | read content from a local file |
| `--root <rootId>` | root id |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf files upload`

Upload a local file to an agent (remotePath defaults to the file name)

**Usage:** `mf files upload [options] <localPath> [remotePath]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<localPath>` |  |
| `[remotePath]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--root <rootId>` | root id (default: workspace) |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf files download`

Download a file from an agent (localPath defaults to the file name, - for stdout)

**Usage:** `mf files download [options] <remotePath> [localPath]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<remotePath>` |  |
| `[localPath]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--root <rootId>` | root id (default: workspace) |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf files mkdir`

Create a directory on an agent

**Usage:** `mf files mkdir [options] [agentIdOrPath] [path]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--root <rootId>` | root id |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf files mv`

Move or rename a path on an agent

**Usage:** `mf files mv [options] [agentIdOrFrom] [from] [to]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[agentIdOrFrom]` |  |
| `[from]` |  |
| `[to]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--root <rootId>` | root id |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf files rm`

Remove a file or directory on an agent

**Usage:** `mf files rm [options] [agentIdOrPath] [path]`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--root <rootId>` | root id |
| `--recursive` | remove directories recursively |
| `-y, --yes` | confirm irreversible deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
