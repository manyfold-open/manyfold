---
title: "mf files"
description: "Read/write files on an agent runtime"
order: 9
---
**用法:** `mf files [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
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

**用法:** `mf files roots [options] [agentId]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[agentId]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf files list`

List directory entries on an agent

**用法:** `mf files list [options] [agentIdOrPath] [path]`

**Alias:** `ls`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--root <rootId>` | root id (default: workspace) |
| `--json` | emit raw JSON |
| `-h, --help` | display help for command |

## `mf files stat`

Show file metadata

**用法:** `mf files stat [options] [agentIdOrPath] [path]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--root <rootId>` | root id |
| `--json` | emit raw JSON (default) |
| `-h, --help` | display help for command |

## `mf files read`

Read file contents (to stdout or --output)

**用法:** `mf files read [options] [agentIdOrPath] [path]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--root <rootId>` | root id |
| `--output <localPath>` | write to this local file instead of stdout |
| `-h, --help` | display help for command |

## `mf files write`

Write file contents from --content or --file

**用法:** `mf files write [options] [agentIdOrPath] [path]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--content <data>` | inline content (string) |
| `--file <localPath>` | read content from a local file |
| `--root <rootId>` | root id |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf files upload`

Upload a local file to an agent (remotePath defaults to the file name)

**用法:** `mf files upload [options] <localPath> [remotePath]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<localPath>` |  |
| `[remotePath]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--root <rootId>` | root id (default: workspace) |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf files download`

Download a file from an agent (localPath defaults to the file name, - for stdout)

**用法:** `mf files download [options] <remotePath> [localPath]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<remotePath>` |  |
| `[localPath]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--root <rootId>` | root id (default: workspace) |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf files mkdir`

Create a directory on an agent

**用法:** `mf files mkdir [options] [agentIdOrPath] [path]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--root <rootId>` | root id |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf files mv`

Move or rename a path on an agent

**用法:** `mf files mv [options] [agentIdOrFrom] [from] [to]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[agentIdOrFrom]` |  |
| `[from]` |  |
| `[to]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--root <rootId>` | root id |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf files rm`

Remove a file or directory on an agent

**用法:** `mf files rm [options] [agentIdOrPath] [path]`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `[agentIdOrPath]` |  |
| `[path]` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--root <rootId>` | root id |
| `--recursive` | remove directories recursively |
| `-y, --yes` | confirm irreversible deletion |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
