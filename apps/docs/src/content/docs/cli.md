---
title: Manyfold CLI
description: Use mf to manage agents, runtimes, channels, files, automations, and more from a terminal.
order: 2
---

# Manyfold CLI

The `mf` CLI is the terminal interface to Manyfold. Use it for interactive administration, scripts, CI jobs, and connecting a self-owned computer. It is distributed as a standalone binary for macOS, Linux, and Windows; normal use does not require Node.js.

Start with [Install the CLI](../install/), then sign in:

```sh
mf setup
mf whoami
mf --help
```

`mf setup` signs in, registers the current machine, and starts its local
daemon. If you only want the client, install without setup and run `mf login`.

## What you can manage

| Task                        | Command                            | Examples                                                                                      |
| --------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| First-time setup            | `mf setup`                         | Sign in, register this machine, and start its daemon in one flow.                             |
| Authentication and identity | `mf login`, `mf whoami`, `mf auth` | Sign in, inspect the current identity, request a missing capability.                          |
| Agents                      | `mf agent`                         | List, inspect, create, update, delete, configure credentials, and report storage usage.       |
| Runtimes                    | `mf runtime`                       | Inspect and manage agent runtimes, hosted framework agents, control UI, and Hermes dashboard. |
| Model configuration         | `mf model-config`                  | Read/update an agent's model configuration and refresh its model list.                        |
| Channels                    | `mf channels`                      | Create, update, register, test, send through, and manage sessions for IM channels.            |
| Automations                 | `mf automations`                   | Create schedules, update them, inspect runs, or trigger a run immediately.                    |
| Runtime files               | `mf files`                         | List, read, write, move, and remove files exposed by an agent runtime.                        |
| Backups                     | `mf backups`                       | Create/list backups, restore an agent, and inspect restore status.                            |
| Skills                      | `mf skills`                        | Discover, install, enable/disable, and uninstall agent skills.                                |
| Usage                       | `mf usage`                         | Query summaries, time series, events, session totals, and top agents.                         |
| Connections                 | `mf connections`                   | List connections available to the current agent or account.                                   |
| Agent-to-agent              | `mf a2a`                           | Inspect Agent Cards, call granted peers, and track A2A tasks.                                 |
| Self-owned computer         | `mf daemon`                        | Register a machine, install autostart, check status/logs, and diagnose frameworks.            |
| Profiles and environments   | `mf profile`                       | Inspect, select, and remove isolated CLI control-plane profiles.                              |
| CLI lifecycle and help      | `mf update`, `mf help`             | Check/install CLI updates and open human- or agent-oriented help.                             |

Run `mf <command> --help` before a write or destructive operation to see the current arguments and flags. The CLI help is the exact reference for the installed version.

## Common workflows

### Inspect an agent

```sh
mf agent list
mf agent get agt_xxx
mf runtime list
mf model-config get agt_xxx
```

### Work with channels

```sh
mf channels list --agent-id agt_xxx
mf channels test chn_xxx
mf channels sessions list chn_xxx --scope-key '<scope>'
```

See [Connect channels](../channels/) for provider setup and [Session switching](../channels/session-switching/) for the chat command model.

### Read or write runtime files

```sh
mf files roots agt_xxx
mf files list agt_xxx workspace
mf files read agt_xxx workspace/README.md
mf files write agt_xxx workspace/note.txt --content 'hello'
```

To move whole files, use `upload` and `download`. They stream, so transferring a
large file does not depend on its size fitting in memory, and a download that is
interrupted leaves the existing local file untouched:

```sh
mf files upload ./report.csv workspace/report.csv --agent-id agt_xxx
mf files download workspace/report.csv ./report.csv --agent-id agt_xxx
```

With `--agent-id` set (or `MF_AGENT_ID` in a runtime), the agent argument can be
left off any `mf files` command: `mf files ls workspace`.

Paths must stay inside a file root exposed by the agent runtime. `mf files roots`
reports each root's upload and download limits; an upload over the limit is
refused before the transfer starts.

### Manage an automation

```sh
mf automations list --agent-id agt_xxx
mf automations get aut_xxx
mf automations run aut_xxx
```

Use `mf automations create --help` or `update --help` for the current schedule and payload options.

### Connect your own machine

```sh
mf daemon register --token ldt_xxx
mf daemon status
mf daemon doctor
```

Follow [Register a self-owned computer](../local-daemons/) for token issuance, autostart, and troubleshooting.

## Authentication and context

For normal terminal use, `mf login` opens browser authentication and stores the resulting CLI profile locally. Use `mf whoami` to verify which account is active. When the terminal has no browser of its own — an SSH session, for example — add `--no-launch-browser` to sign in by pasting an authorization code instead. See [Install the CLI](../install/).

Global options can override the configured context for one command:

| Option or environment variable    | Purpose                                                                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--profile <name>` / `MF_PROFILE` | Select an isolated CLI profile. Stable binaries default to `default`; dev binaries default to `staging`.                                                  |
| `--api-url <url>` / `MF_API_URL`  | Use a different Manyfold API deployment.                                                                                                                  |
| `--token <token>` / `MF_TOKEN`    | Override the stored credential for one shell or command. Use `--token -` to read from stdin; direct values may appear in shell history and process lists. |
| `--agent-id <id>` / `MF_AGENT_ID` | Select an agent context for commands that support it.                                                                                                     |
| `--account`                       | Explicitly operate across the account instead of only the current agent context; may require user-granted permission.                                     |
| `MF_HTTP_TIMEOUT`                 | Set the timeout for ordinary API requests. The default is `30s`; use a plain number for seconds or a duration suffix such as `ms`, `s`, `m`, or `h`.      |

See [Profiles and environments](../profiles/) before using one machine with
multiple Manyfold deployments.

Most resource commands support `--json` for scripts. Successful payloads go
to stdout; structured failures go to stderr with stable exit codes. See
[Scripting with mf](../scripting/) for the complete contract.

## Agent identities and permissions

Inside a Manyfold-managed agent runtime, `mf` can use the injected agent identity instead of an interactive login. Operations on that agent are scoped automatically. Account-wide access or another agent's resources may require an explicit grant.

When an agent reports a missing capability, request only the required scope:

```sh
mf auth ensure --scopes channels:read,channels:edit
```

The command produces a consent URL for the user to approve. Never share or print the underlying token.

## Updating and troubleshooting

```sh
mf update --check
mf update
mf help
```

- Installed standalone binaries can self-update on macOS, Linux, and Windows. Downloads are SHA-256 verified and extracted in-process; no system `tar` or `unzip` command is required.
- Use `mf <command> --help` when an option is rejected; commands can change between CLI versions.
- Use `mf whoami` when authentication or account selection looks wrong.
- Use `mf daemon doctor` for self-owned computer and local framework problems.
- After updating a running local daemon, restart it so the autostart service uses the new binary.

## See also

- [Install the CLI](../install/)
- [Profiles and environments](../profiles/)
- [Scripting with mf](../scripting/)
- [CLI command reference](../cli-reference/)
- [Register a self-owned computer](../local-daemons/)
- [Manage agents with the CLI](../cli-agents/)
- [Manage runtimes with the CLI](../cli-runtimes/)
- [Manage automations with the CLI](../cli-automations/)
- [Back up and restore agents](../cli-backups/)
- [Manage skills with the CLI](../cli-skills/)
- [Query usage with the CLI](../cli-usage/)
- [Call peer agents with the CLI](../cli-a2a/)
- [Connect channels](../channels/)
