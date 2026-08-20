---
title: Create your first agent
description: Choose a framework, runtime, provider, and workspace for a new agent.
order: 3
---

# Create your first agent

An agent is a hosted workspace plus an AI runtime. It keeps the chat, files, terminal, model settings, and channel connections for that agent in one place.

## Before you start

- Sign in to Manyfold.
- Add a model provider in [Model providers](../model-providers/), or confirm your workspace has managed model access.
- Decide what kind of work the agent should do.

## Choose a framework

Use the framework that matches the job:

| Framework | Best for |
| --- | --- |
| Claude Code | Repository work, implementation tasks, terminal workflows, and long-running coding sessions. |
| Codex | Codebase changes, reviews, and workspace-aware development tasks. |
| Gemini CLI | Coding and general terminal automation with Google Gemini. |
| Hermes Agent | Connector-heavy workflows and background work. |
| OpenClaw | Tool-rich agent applications that need services, gateways, or scheduled jobs. |
| NarraNexus | Narrative-driven agent workspaces with native provider and chat management. |

## Choose where it runs

Most users should start with **Stateful sandbox**. It gives the agent an isolated cloud workspace that can pause and resume while keeping its files and session state.

Use **Cloud computer** when the agent needs an always-on process, connector, service, or scheduled workflow. Rent the cloud computer from **Settings -> Plan & billing -> Buy container**, then attach the agent to it from **New agent**.

Use **Self-owned computer** when you want Manyfold to route work to your own machine. Self-owned computers are registered with the local daemon flow in **Settings -> Self-owned computers**.

## Create the agent

1. Open **New agent**.
2. Pick the framework.
3. Pick where the agent runs. For a cloud computer, choose an existing computer you already rented.
4. Select or add the model provider key requested by the framework.
5. Review the model settings if they are shown.
6. Create the agent.

Manyfold opens the chat workspace when creation finishes. If creation fails, the progress panel shows which setup step needs attention.

## First task

Start with a small, concrete request:

```text
Inspect this repository and summarize the main app structure.
```

For coding work, ask the agent to explain its plan before making changes:

```text
Review the authentication flow and propose the smallest safe fix for the failing login test.
```

## What happens next

- The chat thread becomes the agent's working session.
- Files and terminal access stay attached to the workspace.
- You can close the browser and return later.
- You can connect the same agent to a team channel after it is working.

## Delete or replace an agent

Open **Settings -> Agents**, choose the agent, and use the available runtime or agent controls. Deleting an agent stops new work for that agent; keep your own backups for any files you cannot lose.
