---
title: Design a multi-agent workflow
description: Let one agent plan and integrate, then delegate well-bounded research, implementation, and review work to specialist peers.
order: 12
---
**Every Manyfold agent has an independent workspace.** For a multi-agent workflow, make one Orchestrator agent responsible for decomposition and integration, use A2A to delegate bounded work to authorized peer agents, and hand off results through Git, attachments, or explicitly shared storage.

A2A is an authorized, trackable task-call protocol, not an unbounded group chat between agents.

A calling agent can send work only after the target agent has enabled A2A exposure and authorized that caller as a peer. There is no default rule that every agent in a team can automatically call every other one.

## Before you begin

- **A2A multi-agent workflow**: At least two Manyfold agents, clear role boundaries, and peer authorization on the target agent.
- **Keep secrets server-side**: Use official docs, least-privilege credentials, and a staging check before production.

## Independent workspaces are not automatically shared folders

Every Manyfold agent has its own chat sessions, files, terminal access, skills, and settings. A file created in one agent's workspace does not automatically appear in another agent's workspace.

| What needs a handoff | Recommended method |
| -------------------- | ------------------ |
| Research findings, acceptance criteria, and risks | Return a structured brief over A2A, or attach an explicit input file. |
| Code changes | Use a Git branch, commit, or pull request—not a chat-only summary. |
| Larger documents or material | Use a versioned repository, controlled shared storage, or `--input-file` for a file the peer should process. |
| Follow-up questions | Reuse the task's `contextId` and continue only the context you need. |

## A recommended role design: one coordinator, multiple specialists

| Layer | Agent | Responsibility |
| ----- | ----- | -------------- |
| **Coordination** | Orchestrator agent | Clarifies the goal, decomposes work, chooses callable peers, checks results, and decides the next step. It is the one accountable entry point for the user. |
| **Specialist** | Research / Builder / Reviewer agents | A Researcher investigates read-only; a Builder changes a bounded repository and branch; a Reviewer independently checks the diff, tests, and specification. Each role receives verifiable scope. |
| **Delivery** | Git and deployment workflow | Code flows through branches, pull requests, review, and CI/CD. Deployment access should be separate from ordinary research or implementation access. |

Start with two or three roles. Add agents only after a single agent is reliable, work can genuinely be split, and each result can be checked.

## Set up one peer A2A call

For example, to let `agt_orchestrator` call `agt_researcher`:

1. Open the target agent (Researcher), go to its **A2A** tab, and enable exposure.
2. In the target agent's caller settings, authorize the Orchestrator as a peer caller.
3. From the Orchestrator terminal, inspect callable peers, then send work.

```sh
# Target agent: enable A2A and authorize the caller
mf --agent-id agt_researcher a2a exposure enable
mf --agent-id agt_researcher a2a callers add \
  --caller-agent-id agt_orchestrator

# Orchestrator runtime / terminal: discover and call the peer
mf a2a status
mf a2a send agt_researcher "Summarize today's open pull requests."
```

**Exposure and caller grants are independent controls.** If the target agent is not exposed, A2A calls receive `404`. Without the corresponding peer grant, that agent identity cannot call the target. Each grant should cover only the target agent actually required.

## How to write an executable delegation

Do not simply say "research this." A useful A2A delegation states the goal, scope, constraints, deliverable, and stop condition:

```sh
mf a2a send agt_researcher \
  "Goal: map the authentication flow.
   Scope: inspect src/auth and related tests read-only; do not edit or commit.
   Deliverable: file list, data flow, three risks, and a minimal fix proposal.
   Stop condition: stop after returning that brief."
```

For a long turn, either stream progress or submit asynchronously and track the task ID:

```sh
mf a2a send agt_researcher "Run the full audit." --stream

mf a2a send agt_researcher "Run the full audit." --async --json
mf a2a tasks get agt_researcher aat_xxx --wait
```

After a network interruption, query or resubscribe to the existing task before resending the prompt; an immediate retry can create duplicate work. For an intentional follow-up, pass the returned `contextId`.

## From research to implementation: a practical handoff

| Hands off | Picks up |
| --------- | -------- |
| **Researcher** analyzes read-only and returns a brief | **Orchestrator** confirms scope and creates an executable task |
| **Orchestrator** gives acceptance criteria and branch rules to Builder | **Builder** changes, tests, and commits on an independent branch |
| **Reviewer** independently reviews the diff and tests | **Orchestrator** integrates results and asks for approval or the next step |

The important part is that every agent has inspectable inputs and outputs. For code, the real handoff should be a commit or pull request, not the sentence "I changed it."

## Multi-agent operating guardrails

- **One owner:** Let the Orchestrator own the final response and next action, so several agents do not make competing decisions for the same goal.
- **Least privilege:** Researcher and Reviewer are read-only by default; Builder writes only to an intended repository and branch; deployment access is granted separately.
- **Avoid loops:** Set turn, budget, and stop limits for peers. Do not let two agents question each other without a bounded termination condition.
- **Inspect before retrying:** For long work, use task get, subscribe, or cancel before repeating an invocation.
- **Keep human gates:** Require human approval for production deployment, external sending, data deletion, or permission changes.

> **A2A calls count toward the account's API quota.** Use Settings → Usage to inspect agent and provider usage. Stop and inspect model, permissions, and delegation design when a task is unexpectedly expensive.

## Frequently asked questions

- **Do multiple agents share one workspace?**

  No. Every agent has its own sessions, files, terminal, skills, and settings. Use A2A, Git, or explicitly shared storage for handoffs; do not assume files are shared automatically.
- **How can one agent call another agent?**

  Enable A2A exposure on the target agent and authorize the caller as a peer. The caller uses `mf a2a status` to find peers, then `mf a2a send` to delegate work.
- **When should I use A2A?**

  Use it when an agent or external system needs a protocol-based, authorized, and trackable way to call another agent. It is not always needed for small tasks you manually assign in separate chats.

**Need the visual A2A setup steps?** Read [Configure A2A permissions](/docs/a2a/permissions/).

**Need to choose where each Agent runs?** Read the [runtime selection guide](/docs/choose-a-runtime/) before assigning work to a sandbox or your own computer.

## See also

- [A2A API docs](/docs/api-a2a/)
- [mf CLI guide](/docs/cli/)
- [Runtime selection guide](/docs/choose-a-runtime/)
- [Manyfold: call agents over A2A](/docs/api-a2a/)
- [Manyfold: call peer agents with the CLI](/docs/cli/a2a/)
- [Manyfold CLI reference: A2A callers, send, and tasks](/docs/cli/reference/)
- [Manyfold: use the workspace](/docs/workspace/)
- [A2A Protocol](https://a2a-protocol.org/)
