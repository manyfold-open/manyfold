---
title: "mf daemon"
description: "Local daemon for Manyfold agents (claude-code / codex / gemini-cli)"
order: 16
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
| `-y, --yes` | skip confirmation and start the daemon after registering |
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
