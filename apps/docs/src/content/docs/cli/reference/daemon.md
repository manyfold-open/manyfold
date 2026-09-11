---
title: "mf daemon"
description: "Local daemon for Manyfold agents (claude-code / codex / gemini-cli / pi)"
order: 17
---
**Usage:** `mf daemon [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
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

**Usage:** `mf daemon register [options]`

**Options**

| Options | Purpose |
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

**Usage:** `mf daemon start [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--foreground` | run inline without touching the init unit (debug / used by the unit itself) |
| `--system` | install at system scope (boot-time; needs root/sudo; default as root) |
| `--user` | install at user scope (per-login; default as non-root) |
| `-h, --help` | display help for command |

## `mf daemon status`

Show local daemon status

**Usage:** `mf daemon status [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf daemon stop`

Stop the Manyfold daemon and remove its autostart unit

**Usage:** `mf daemon stop [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--system` | target system scope (boot-time unit; needs root/sudo; default as root) |
| `--user` | target user scope (per-login unit; default as non-root) |
| `--keep-execs` | leave running execs alone for the next daemon to adopt (default: stop the process groups this daemon owns) |
| `-h, --help` | display help for command |

## `mf daemon logs`

Tail the daemon log

**Usage:** `mf daemon logs [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `-f, --follow` | follow log output |
| `-n, --lines <count>` | number of lines to show Default: `50`. |
| `-h, --help` | display help for command |

## `mf daemon doctor`

Probe local frameworks and daemon terminal support

**Usage:** `mf daemon doctor [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

## `mf daemon hooks`

Session hooks Manyfold installs into claude / codex settings (act only inside Manyfold terminals)

**Usage:** `mf daemon hooks [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-h, --help` | display help for command |

**Subcommands**

| Command | Purpose |
| --- | --- |
| [`mf daemon hooks install`](#mf-daemon-hooks-install) | Install the session hooks for the frameworks on this machine and keep them current on daemon start |
| [`mf daemon hooks uninstall`](#mf-daemon-hooks-uninstall) | Remove the session hooks Manyfold installed |
| [`mf daemon hooks status`](#mf-daemon-hooks-status) | Show which frameworks have the session hooks installed |
| [`mf daemon hooks report`](#mf-daemon-hooks-report) | Used by the installed hooks: forward the hook JSON on stdin to Manyfold (no-op outside a Manyfold terminal) |

### `mf daemon hooks install`

Install the session hooks for the frameworks on this machine and keep them current on daemon start

**Usage:** `mf daemon hooks install [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

### `mf daemon hooks uninstall`

Remove the session hooks Manyfold installed

**Usage:** `mf daemon hooks uninstall [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

### `mf daemon hooks status`

Show which frameworks have the session hooks installed

**Usage:** `mf daemon hooks status [options]`

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |

### `mf daemon hooks report`

Used by the installed hooks: forward the hook JSON on stdin to Manyfold (no-op outside a Manyfold terminal)

**Usage:** `mf daemon hooks report [options] <framework>`

**Arguments**

| Argument | Purpose |
| --- | --- |
| `<framework>` |  |

**Options**

| Options | Purpose |
| --- | --- |
| `--json` | output the result as JSON |
| `-h, --help` | display help for command |
