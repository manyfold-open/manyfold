---
title: CLI command reference
description: Search the complete mf command tree, arguments, and options.
order: 12
---
This page is generated from the same Commander tree as the mf binary. It documents the current public command surface; the installed binary remains authoritative for its own version.

**Generated from:** `mf 0.23.3`

Run `mf <command> --help` to confirm syntax for the version installed on your machine.

## Commands

| Command | Purpose |
| --- | --- |
| [`mf auth`](/docs/cli/reference/auth/) | Authenticate and manage capabilities for the current identity |
| [`mf setup`](/docs/cli/reference/setup/) | One-command onboarding: sign in, register this machine as a daemon, start it |
| [`mf login`](/docs/cli/reference/login/) | Authenticate this machine with Manyfold |
| [`mf whoami`](/docs/cli/reference/whoami/) | Print the currently authenticated user |
| [`mf agent`](/docs/cli/reference/agent/) | Manage agents |
| [`mf automations`](/docs/cli/reference/automations/) | Manage scheduled automations |
| [`mf backups`](/docs/cli/reference/backups/) | Manage agent backups and restores |
| [`mf channels`](/docs/cli/reference/channels/) | Manage agent channels (Telegram, Lark, Slack, etc.) |
| [`mf files`](/docs/cli/reference/files/) | Read/write files on an agent runtime |
| [`mf connections`](/docs/cli/reference/connections/) | List the connections linked to this agent (or, for a user, your account) |
| [`mf model-config`](/docs/cli/reference/model-config/) | Read/update agent model configuration |
| [`mf runtime`](/docs/cli/reference/runtime/) | Manage agent runtimes (the sprite/pod shell) |
| [`mf skills`](/docs/cli/reference/skills/) | Manage installed agent skills |
| [`mf usage`](/docs/cli/reference/usage/) | Read token + cost usage statistics |
| [`mf a2a`](/docs/cli/reference/a2a/) | Talk to A2A servers and manage this agent exposure and callers |
| [`mf daemon`](/docs/cli/reference/daemon/) | Local daemon for Manyfold agents (claude-code / codex / gemini-cli) |
| [`mf profile`](/docs/cli/reference/profile/) | Inspect and manage CLI profiles (ADR-0014) |
| [`mf update`](/docs/cli/reference/update/) | Update the mf CLI to the latest version |
| [`mf help`](/docs/cli/reference/help/) | display help for a command; --agent prints the agent operations guide |

## Global options

**Usage:** `mf [options] [command]`

**Options**

| Options | Purpose |
| --- | --- |
| `-V, --version` | output the version number |
| `--profile <name>` | CLI profile: separate credentials and daemon state per environment (env: MF_PROFILE) |
| `--api-url <url>` | API base URL |
| `--token <token>` | API token override ("-" reads stdin; direct values may appear in shell history and process lists) |
| `--agent-id <id>` | agent context: default agent for agent-scoped commands, accepted before or after the subcommand (env: MF_AGENT_ID) |
| `--account` | act at account scope: operate across the current account instead of only the current agent (default). Requires user-granted permission; without it the command stays scoped to the current agent. |
| `-h, --help` | display help for command |
