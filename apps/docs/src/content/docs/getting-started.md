---
title: Getting started
description: What Manyfold does and the shortest path to a working agent.
order: 1
---

# Getting started

Manyfold lets you create hosted AI agents, give them a workspace, and talk to them from the web app, CLI, or team chat tools.

You can start with a coding agent such as Claude Code, Codex, or Gemini CLI, then add framework agents for longer-running workflows when you need them.

## What you can do

- Create cloud-hosted agents for code, repository work, automation, and team workflows.
- Keep each agent's files, chat sessions, terminal state, and settings together.
- Connect model providers such as Anthropic, OpenAI, Google Gemini, or OpenRouter.
- Install skills so agents can follow repeatable workflows.
- Reach the same agent from the web workspace, the `mf` CLI, Slack, Lark, Feishu, Telegram, Discord, or Matrix.
- Review sessions, usage, channel deliveries, and runtime status from the product UI.

## First setup

1. Sign in to Manyfold.
2. Add a model provider key in **Settings -> Model providers**, unless your workspace already has managed model access.
3. Create your first agent from **New agent**.
4. Choose the agent framework and runtime mode.
5. Open the chat workspace and send the first task.

For terminal access, install the CLI after signing in:

```sh
curl -fsSL https://cdn1.manyfold.ai/cli/install.sh | sh
mf login
mf whoami
```

## Learn next

- [Install the CLI](../install/)
- [Create your first agent](../create-agent/)
- [Connect model providers](../model-providers/)
- [Use the workspace](../workspace/)
- [Connect channels](../channels/)
