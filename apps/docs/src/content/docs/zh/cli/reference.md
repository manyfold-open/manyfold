---
title: CLI 命令参考
description: 搜索完整的 mf command tree、argument 和 option。
order: 12
---
本页由 mf binary 使用的同一份 Commander tree 生成，记录当前公开 command surface；command 和 option description 保留 binary 中的英文原文以避免漂移。已安装 binary 的自身版本始终是最终依据。

**生成自:** `mf 0.25.0`

运行 `mf <command> --help`，确认当前机器已安装版本的准确语法。

## 命令

| 命令 | 用途 |
| --- | --- |
| [`mf auth`](/zh/docs/cli/reference/auth/) | Authenticate and manage capabilities for the current identity |
| [`mf setup`](/zh/docs/cli/reference/setup/) | One-command onboarding: sign in, register this machine as a daemon, start it |
| [`mf login`](/zh/docs/cli/reference/login/) | Authenticate this machine with Manyfold |
| [`mf whoami`](/zh/docs/cli/reference/whoami/) | Print the currently authenticated user |
| [`mf agent`](/zh/docs/cli/reference/agent/) | Manage agents |
| [`mf automations`](/zh/docs/cli/reference/automations/) | Manage scheduled automations |
| [`mf backups`](/zh/docs/cli/reference/backups/) | Manage agent backups and restores |
| [`mf channels`](/zh/docs/cli/reference/channels/) | Manage agent channels (Telegram, Lark, Slack, etc.) |
| [`mf files`](/zh/docs/cli/reference/files/) | Read/write files on an agent runtime |
| [`mf connections`](/zh/docs/cli/reference/connections/) | List the connections linked to this agent (or, for a user, your account) |
| [`mf model-config`](/zh/docs/cli/reference/model-config/) | Read/update agent model configuration |
| [`mf runtime`](/zh/docs/cli/reference/runtime/) | Manage agent runtimes (the sprite/pod shell) |
| [`mf skills`](/zh/docs/cli/reference/skills/) | Manage installed agent skills |
| [`mf usage`](/zh/docs/cli/reference/usage/) | Read token + cost usage statistics |
| [`mf a2a`](/zh/docs/cli/reference/a2a/) | Talk to A2A servers and manage this agent exposure and callers |
| [`mf daemon`](/zh/docs/cli/reference/daemon/) | Local daemon for Manyfold agents (claude-code / codex / gemini-cli) |
| [`mf profile`](/zh/docs/cli/reference/profile/) | Inspect and manage CLI profiles (ADR-0014) |
| [`mf update`](/zh/docs/cli/reference/update/) | Update the mf CLI to the latest version |
| [`mf version`](/zh/docs/cli/reference/version/) | Show the installed version, update channel and build metadata |
| [`mf help`](/zh/docs/cli/reference/help/) | display help for a command; --agent prints the agent operations guide |

## Global option

**用法:** `mf [options] [command]`

**Option**

| Option | 用途 |
| --- | --- |
| `-V, --version` | output the version number |
| `--profile <name>` | CLI profile: separate credentials and daemon state per environment (env: MF_PROFILE) |
| `--api-url <url>` | API base URL |
| `--token <token>` | API token override ("-" reads stdin; direct values may appear in shell history and process lists) |
| `--agent-id <id>` | agent context: default agent for agent-scoped commands, accepted before or after the subcommand (env: MF_AGENT_ID) |
| `--account` | act at account scope: operate across the current account instead of only the current agent (default). Requires user-granted permission; without it the command stays scoped to the current agent. |
| `-h, --help` | display help for command |
