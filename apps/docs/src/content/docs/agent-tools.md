---
title: Manyfold and agent frameworks
description: These products are not in the same category. Once you separate models, agent frameworks, an agent platform, and runtimes, it becomes clear how they work together.
order: 6
---
**Quick answer:** **Claude Code, Codex, Gemini CLI, OpenClaw, and Hermes** are agent frameworks that execute work. **Manyfold** is the platform that creates, hosts, manages, connects, and makes those agents collaborative. It does not replace them; it places them in a shared environment with workspaces, sessions, terminals, skills, channels, and runtimes.

## First, separate the four layers

| Layer | Products | What it provides |
| ----- | -------- | ---------------- |
| **1. Models and model providers** | Anthropic, OpenAI, Google Gemini, OpenRouter | They provide AI reasoning capability and credentials. Manyfold can connect these providers, and some workspaces can have managed model access. |
| **2. Agent frameworks** | Claude Code, Codex, Gemini CLI, OpenClaw, Hermes | They receive tasks, use tools, read and write files, and perform the work. Each framework has different strengths and operating patterns. |
| **3. Agent platform and control layer** | Manyfold | It creates and hosts agents, and keeps their workspaces, chat sessions, files, terminals, model settings, skills, channels, automations, usage, and runtime status together. |
| **4. Where an agent runs** | Stateful sandbox, self-owned computer, cloud computer | The runtime decides whether the agent executes in an isolated Manyfold cloud environment, on your own computer, or on a long-running cloud computer. |

## What is Manyfold?

Manyfold is an agent workspace and control platform, not simply a chat interface. It lets you create agents, give them a workspace and runtime, and use them from the web, CLI, or team chat tools. It keeps each agent's files, chat sessions, terminal state, settings, skills, and channel connections together.

In other words, Manyfold solves the problem of bringing agents into real work and team collaboration. It is not another Claude, GPT, or Gemini model, and it does not aim to replace Claude Code, Codex, or Gemini CLI.

## Full comparison

| Tool or category | What it is | Best for | Relationship with Manyfold |
| ---------------- | ---------- | -------- | -------------------------- |
| **Manyfold** | Agent workspace, control, and collaboration platform | Creating, managing, connecting, and observing multiple agents and team workflows | Hosts and manages agent frameworks; can select models and runtimes |
| **Claude Code** | Coding agent framework | Repository work, implementation tasks, terminal workflows, and long-running coding sessions | Can be selected as an agent framework in Manyfold |
| **Codex** | Coding agent framework | Codebase changes, code review, and workspace-aware development work | Can be selected as an agent framework in Manyfold |
| **Gemini CLI** | Coding and terminal agent framework | Coding and general terminal automation using Google Gemini | Can be selected as an agent framework in Manyfold |
| **Hermes Agent** | Framework-style agent | Connector-heavy workflows and background work | Can be created, managed, and connected in Manyfold |
| **OpenClaw** | Framework-style agent | Tool-rich agent applications that need services, gateways, or scheduled jobs | Can be created, managed, and connected in Manyfold |

These roles come from Manyfold's framework selection guidance. Exact capabilities, available models, and credentials depend on the framework, provider, and runtime you choose.

## What does Manyfold add?

When you use a coding agent by itself, you usually interact with one agent in a local terminal. When you connect it to Manyfold, the framework still performs the task, but Manyfold adds a unified team and operations layer:

- A separate, resumable chat session, workspace files, and terminal access for every agent.
- Model provider, model-setting, usage, and cost management.
- Reusable skills and automations.
- Connections to Slack, Lark, Feishu, Telegram, Discord, Matrix, and other team channels.
- A choice of sandbox, self-owned computer, or cloud-computer runtime, with runtime status in the product UI.

## How should you choose?

| If you need | Start with |
| ----------- | ---------- |
| AI help to change or review one repository | **Claude Code** or **Codex** |
| An established development workflow that depends on Gemini | **Gemini CLI** |
| Connectors, services, background work, or scheduled jobs | **Hermes Agent** or **OpenClaw** |
| Several agents under one team, connected channels, tracked usage, or different runtimes | **Manyfold** to manage the selected framework |

### An example combination

An engineering team can create a **Codex agent** in Manyfold, run it on a **self-owned computer**, point its workspace at a local repository, and choose either local credentials or a Manyfold-managed provider. Codex changes the code; Manyfold preserves the session, provides a team chat entry point, and manages runtime status and usage.

### Can I use Claude Code or Codex without Manyfold?

Yes. They can be used independently as coding agents. Manyfold adds value when you need shared workspaces, centralized model and credential management, team channels, automation, multi-agent collaboration, or multiple runtimes.

## Frequently asked questions

- **Is Manyfold a replacement for Claude Code, Codex, or Gemini CLI?**

  No. They are different layers: Claude Code, Codex, and Gemini CLI do the agent work; Manyfold creates, hosts, manages, connects, and makes those agents collaborative.
- **How are OpenClaw and Hermes different from coding agents?**

  Manyfold positions Hermes Agent and OpenClaw as framework-style agents, better suited to connectors, services, scheduled jobs, or product workflows. Claude Code, Codex, and Gemini CLI focus on codebase and terminal work.
- **Does Manyfold provide models?**

  Manyfold can connect providers such as Anthropic, OpenAI, Google Gemini, and OpenRouter. Some workspaces can also have managed model access. The available source depends on the selected agent and settings.

## See also

- [Manyfold CLI: manage agents, runtimes, channels, automations, and skills](/docs/cli/)
- [Runtime selection guide](/docs/choose-a-runtime/)
- [Create your first agent: choose a framework and runtime](/docs/create-agent/)
- [Getting started: what Manyfold can manage](/docs/getting-started/)
- [Manyfold FAQ](/docs/faq/)
