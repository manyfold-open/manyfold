---
title: What is Manyfold A2A?
description: 'A2A is the Agent-to-Agent collaboration layer: one agent can call another with explicit authorization, scope, and task state.'
order: 10
---
**A2A lets one agent call another agent.** The target agent must expose A2A and authorize the caller as a peer. Tasks can then be sent, tracked, and cancelled.

A2A is not an automatic group chat and it is not a shared-workspace protocol.

## The A2A collaboration model

| Example | Agent | What it does |
| ------- | ----- | ------------ |
| **Caller** | Orchestrator agent | For example, an Orchestrator agent can break down the goal, select a peer, send a bounded task, and check the result. |
| **Peer** | Researcher / Builder / Reviewer | For example, these specialist agents can complete focused tasks inside their own workspace and permission boundary; real roles can vary by workflow. |
| **Handoff** | Result, Git, or shared storage | For example, a workflow can pass structured results, commits, pull requests, or explicitly shared files to the next step. |

Each agent keeps its own sessions, files, terminal, skills, and settings. A2A provides controlled task calls and result delivery.

> **These roles are examples only.** A2A is not limited to Researcher, Builder, or Reviewer workflows; for example, support, information processing, data analysis, content generation, testing, and operations can use different agent roles as needed.

## When should you use A2A?

- For example, when research, implementation, and review need separate agent roles.
- An external app needs a protocol-based agent call.
- Tasks require authorization, status, and result tracking.
- A single agent has reached a context or tool boundary.

The research, implementation, and review workflow above is only an example; real roles can be adapted to the business context, such as support, information processing, data analysis, content generation, testing, or operations.

If you are manually copying a short note between two chats, direct Chat or API calls are usually simpler.

**Want to turn A2A into a real multi-agent workflow?** Read the [A2A multi-agent guide](/docs/a2a/workflows/) for role design, authorization, handoffs, and task tracking.

## See also

- [Read the A2A multi-agent guide](/docs/a2a/workflows/)
- [Configure A2A agent permissions](/docs/a2a/permissions/)
- [Call peer agents with mf CLI](/docs/cli/a2a/)
- [Call agents over A2A](/docs/api-a2a/)
