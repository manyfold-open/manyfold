---
title: Manage agents with the CLI
description: Create, inspect, update, delete, and configure Manyfold agents from mf.
order: 5
---
Use `mf agent` for agent records and credentials. Model settings have their
own `mf model-config` group; agents hosted inside an existing runtime are
managed with `mf runtime agents`.

## Inspect agents

```sh
mf agent list
mf agent get agt_xxx
mf agent storage-usage agt_xxx
```

Add `--json` for scripts. An agent runtime identity sees its own context by
default. Account access from a runtime requires explicit `--account` and the
corresponding consent grant; a human login keeps its account access.

## Storage

```sh
mf sandbox storage-usage --json
mf --account sandbox storage-usage --json
mf agent storage-usage agt_xxx --json
```

The first command reports the current sandbox's cached whole-filesystem usage.
Outside an agent runtime, select `--agent-id agt_xxx` or use `--account`.
The account report includes each sandbox once, including empty and sleeping
sandboxes, sorted by storage usage. Runtime account reads require `agents:read`
consent. Both reports include `scope`, byte units, measurement times and
freshness; reading them never wakes a sleeping sandbox.

`agent storage-usage` is an agent-owned path diagnostic, not the account meter.
It measures workspace and configuration paths only when the sandbox is running.
Sleeping or unavailable sandboxes return unknown path values and retain their
cached sandbox reading separately. An unknown value is `null`, not zero.

Agent records expose `workspaceBytes` and `workspaceMeasuredAt` together instead
of the ambiguous `storageBytes` and `storageMeasuredAt`. Workspace values are raw
directory sizes; they must not be summed to reconstruct whole-sandbox storage.
The sandbox report separately exposes known-path attribution, which accounts for
nested or aliased paths without claiming exact filesystem or invoice allocation.
Incomplete or inconsistent measurements keep attribution unknown.

`agent list --json` returns `{ "scope": "agent" | "account", "agents": [...] }`.
This is a breaking API/CLI contract change. Upgrade the API and CLI together;
storage commands and agent list/get reject older ambiguous responses explicitly.

## Create a coding agent

`mf agent create` makes a Claude Code, Codex, Gemini CLI, Pi, or Antigravity
CLI agent. Say who serves the agent's model:

```sh
mf agent create review-bot --framework codex --model-provider managed
mf agent create review-bot --model-provider subscription
mf agent create review-bot --framework codex --model-provider "Team OpenAI" --model gpt-6-sol
printenv OPENAI_API_KEY | mf agent create review-bot --framework codex --openai-api-key -
```

- `managed` uses Manyfold managed models.
- `subscription` uses your own subscription to the framework's vendor. A new
  sandbox is not signed in yet: open the chat link the command prints and
  follow its sign-in card, or run the sign-in command it prints in the
  sandbox's terminal.
- A provider id or name uses a model provider you saved and tested in the
  web app. `mf model-providers list --framework codex` shows which of yours
  can serve a framework, and which models `--model` accepts from each. For
  Claude Code, an alias such as `sonnet` follows the newest tested Sonnet
  and an id pins one; `--model "Sonnet 5"` or `--model "sonnet 4.5"` works
  when it names exactly one model. If a model came out after the provider
  was last tested, run `mf model-providers test <provider>` first.
- A key flag uses your own key. `-` reads the key from stdin, which keeps it
  out of shell history. The CLI does not read keys from environment
  variables. Pi takes `--pi-api-key` together with
  `--pi-provider anthropic|openai|google`, the vendor the key belongs to.

Each create makes a new sandbox, which counts against your plan's sandboxes.
To add the agent to a sandbox you already have, name it with `--sandbox`:

```sh
mf sandbox list
mf agent create second-bot --sandbox sandbox-2
```

An agent added to a sandbox where its framework already runs shares the
credentials of the agents there, so pass no model source; to use the
sandbox's own sign-in, pass `--model-provider subscription`. Deleting an
agent does not free its sandbox: once a sandbox has no agents left,
`mf sandbox delete <id|name> --yes` removes it. `mf sandbox update <id|name>`
updates the Manyfold CLI on a sandbox, as the Update Center does; pass
`--to <version>` for a particular build.

The command prints each step as it finishes. If the connection drops, it
picks the create up again. If you press Ctrl-C, the create goes on: run the
same command again to pick it up, or to get the agent it made.

This command does not create daemon, Kubernetes, cloud-computer, external,
Hermes, or OpenClaw agents. Use the web **New agent** flow for the full
framework/runtime matrix. To add an agent to a runtime by its id, use
`mf runtime agents add`.

## Talk to an agent

```sh
mf agent send agt_xxx "summarise the open pull requests"
git diff | mf agent send agt_xxx -
mf agent send agt_xxx -c "and the failing test?"
mf agent send agt_xxx "what is in this screenshot?" --file ./shot.png
```

`mf agent send` sends one message and prints the reply: on stdout, streamed
in a terminal and whole when piped, with tool calls and a footer (model,
tokens, cost, session) on stderr. Each run starts a new session unless
`--session <id>` names one or `-c` continues the one you used last. The
message can come from stdin (`-`). `--file` uploads a local file into the
agent's workspace and attaches it, images included; a message takes up to
10 files of 25 MiB each. `--json` prints the turn as one object. Ctrl-C
stops the turn.

`mf agent chat agt_xxx` is the same conversation at a prompt in your
terminal, one message per line: `/new` starts a new session, `/exit` or
Ctrl-D leaves. `mf agent chat agt_xxx --file ./design.png` attaches a file
or an image to your first message, as context for the rest of the chat.

## Update or delete an agent

```sh
mf agent update agt_xxx --name reviewer
mf agent update agt_xxx --model sonnet
mf agent delete agt_xxx --yes
```

`--model` takes the names `mf agent create` takes: an alias such as
`sonnet`, an id, or a name such as `"Sonnet 5"`. A coding agent keeps its
model in its model settings, so for one the change goes there, as
`mf model-config update --model` makes it. A model those settings do not
offer is refused with a list of the ones they do. The new model runs from
the next message in every session, including conversations already open.

> **Warning:** Deletion is irreversible. The CLI refuses to proceed without
> `--yes`; it does not open an interactive prompt. Pass it only after
> independently verifying the target ID and taking a backup when the workspace
> matters.

## Credentials

```sh
mf agent credentials get agt_xxx
mf agent credentials reveal agt_xxx
mf agent credentials update agt_xxx --body @credentials.json
```

`get` returns metadata without secrets. `reveal` is masked unless `--show` is
passed. Plaintext reveal output is sensitive: do not send it to logs, chat,
issue trackers, or shell history.

The update body uses the framework-specific `UpdateAgentCredentialsBody`.
Inspect the current metadata and command help before changing it. Some
gateway-style frameworks require a rebuild for credential changes that affect
their running service.

## Model configuration

```sh
mf model-config get agt_xxx
mf model-config update agt_xxx --model gpt-5.6 --json
mf model-config update agt_xxx --clear-model --clear-config
mf model-config refresh-models agt_xxx
```

`--source` accepts `platform` or `runtime-local`. A JSON config can be passed
inline or with `--config @file.json`. `--clear-model` puts the agent back on
the model the framework runs by default: on a model provider, the one a new
agent there gets; on a subscription sign-in, the CLI's own default.

## See also

- [Create your first agent](/docs/create-agent/)
- [Manage runtimes with the CLI](/docs/cli/runtimes/)
- [Back up and restore agents](/docs/cli/backups/)
- [CLI command reference](/docs/cli/reference/)
