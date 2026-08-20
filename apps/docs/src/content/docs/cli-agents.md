---
title: Manage agents with the CLI
description: Create, inspect, update, delete, and configure Manyfold agents from mf.
order: 5
---

# Manage agents with the CLI

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
default; a human login can add `--account` for explicit account-wide access.

## Create a sprites.dev coding agent

`mf agent create` currently provisions a new agent on sprites.dev. It supports
Claude Code, Codex, and Gemini CLI:

```sh
mf agent create review-bot \
  --framework codex \
  --openai-api-key "$OPENAI_API_KEY"
```

Provider keys can come from the framework's environment variable. Avoid
putting a literal key in shell history. Run `mf agent create --help` for each
framework's base URL and model options.

This command does not create daemon, Kubernetes, cloud-computer, external,
Hermes, OpenClaw, or NarraNexus agents. Use the web **New agent** flow for the
full framework/runtime matrix. To add another framework agent to an existing
multi-agent runtime, use `mf runtime agents add`.

## Update or delete an agent

```sh
mf agent update agt_xxx --name reviewer
mf agent update agt_xxx --model gpt-5.6
mf agent update agt_xxx --clear-model
mf agent delete agt_xxx --yes
```

Deletion is irreversible. The CLI refuses to proceed without `--yes`; it does
not open an interactive prompt. Pass it only after independently verifying the
target ID and taking a backup when the workspace matters.

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
inline or with `--config @file.json`.

## See also

- [Create your first agent](../create-agent/)
- [Manage runtimes with the CLI](../cli-runtimes/)
- [Back up and restore agents](../cli-backups/)
- [CLI command reference](../cli-reference/)
