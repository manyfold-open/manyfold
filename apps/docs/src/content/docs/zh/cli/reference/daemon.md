---
title: "mf daemon"
description: "Local daemon for Manyfold agents (claude-code / codex / gemini-cli)"
order: 17
---
**用法:** `mf daemon [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf daemon register`](#mf-daemon-register) | Register this machine as a Manyfold local daemon |
| [`mf daemon start`](#mf-daemon-start) | Start the Manyfold daemon (installs init unit so it auto-starts on login) |
| [`mf daemon status`](#mf-daemon-status) | Show local daemon status |
| [`mf daemon stop`](#mf-daemon-stop) | Stop the Manyfold daemon and remove its autostart unit |
| [`mf daemon logs`](#mf-daemon-logs) | Tail the daemon log |
| [`mf daemon doctor`](#mf-daemon-doctor) | Probe local frameworks and daemon terminal support |
| [`mf daemon hooks`](#mf-daemon-hooks) | Session hooks Manyfold installs into claude / codex settings (act only inside Manyfold terminals) |

## `mf daemon register`

Register this machine as a Manyfold local daemon

**用法:** `mf daemon register [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--token <token>` | PAT issued from the web UI ("-" reads stdin; direct values may appear in shell history and process lists) |
| `--name <name>` | human-readable machine name |
| `--workspace-root <path>` | workspace base dir this daemon manages (default: the shared ~/.manyfold/workspaces) |
| `--skills-dir <path>` | skill store dir this daemon manages (default: the shared ~/.manyfold/skills) |
| `-y, --yes` | skip confirmation: start the daemon and install the session hooks after registering |
| `--no-hooks` | do not install the claude / codex session hooks (they act only inside Manyfold terminals) |
| `-h, --help` | display help for command |

## `mf daemon start`

Start the Manyfold daemon (installs init unit so it auto-starts on login)

**用法:** `mf daemon start [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--foreground` | run inline without touching the init unit (debug / used by the unit itself) |
| `--system` | install at system scope (boot-time; needs root/sudo; default as root) |
| `--user` | install at user scope (per-login; default as non-root) |
| `-h, --help` | display help for command |

## `mf daemon status`

Show local daemon status

**用法:** `mf daemon status [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf daemon stop`

Stop the Manyfold daemon and remove its autostart unit

**用法:** `mf daemon stop [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--system` | target system scope (boot-time unit; needs root/sudo; default as root) |
| `--user` | target user scope (per-login unit; default as non-root) |
| `--keep-execs` | leave running execs alone for the next daemon to adopt (default: stop the process groups this daemon owns) |
| `-h, --help` | display help for command |

## `mf daemon logs`

Tail the daemon log

**用法:** `mf daemon logs [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `-f, --follow` | follow log output |
| `-n, --lines <count>` | number of lines to show 默认值: `50`. |
| `-h, --help` | display help for command |

## `mf daemon doctor`

Probe local frameworks and daemon terminal support

**用法:** `mf daemon doctor [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf daemon hooks`

Session hooks Manyfold installs into claude / codex settings (act only inside Manyfold terminals)

**用法:** `mf daemon hooks [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommand**

| 命令 | 用途 |
| --- | --- |
| [`mf daemon hooks install`](#mf-daemon-hooks-install) | Install the session hooks for the frameworks on this machine and keep them current on daemon start |
| [`mf daemon hooks uninstall`](#mf-daemon-hooks-uninstall) | Remove the session hooks Manyfold installed |
| [`mf daemon hooks status`](#mf-daemon-hooks-status) | Show which frameworks have the session hooks installed |
| [`mf daemon hooks report`](#mf-daemon-hooks-report) | Used by the installed hooks: forward the hook JSON on stdin to Manyfold (no-op outside a Manyfold terminal) |

### `mf daemon hooks install`

Install the session hooks for the frameworks on this machine and keep them current on daemon start

**用法:** `mf daemon hooks install [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

### `mf daemon hooks uninstall`

Remove the session hooks Manyfold installed

**用法:** `mf daemon hooks uninstall [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

### `mf daemon hooks status`

Show which frameworks have the session hooks installed

**用法:** `mf daemon hooks status [options]`

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

### `mf daemon hooks report`

Used by the installed hooks: forward the hook JSON on stdin to Manyfold (no-op outside a Manyfold terminal)

**用法:** `mf daemon hooks report [options] <framework>`

**Argument**

| 参数 | 用途 |
| --- | --- |
| `<framework>` |  |

**Option**

| Option | 用途 |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
