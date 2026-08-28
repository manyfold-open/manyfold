---
title: Launch a Cloudflare app
description: This launch flow sets up both an application and a development agent.
order: 15
---
The app deploys to Cloudflare, while the agent connects to a GitHub repository to make, commit, and advance changes within clear permission boundaries.

[cloudflare-worker-launch](https://github.com/manyfold-open/cloudflare-worker-launch) is a guided launch flow: deploy a Cloudflare app, authorize Manyfold, create or adopt an agent, link a GitHub repository, and check readiness. The goal is not only a one-time deployment, but a durable development path.

The app and the agent keep separate responsibilities: Cloudflare hosts the app; Manyfold manages the agent. GitHub is the bridge for code collaboration between them.

## Before you begin

- **Cloudflare continuous development**: A Cloudflare project, a GitHub repository, a Manyfold account, and least-privilege deployment credentials.
- **Keep secrets server-side**: Use official docs, least-privilege credentials, and a staging check before production.

## The five-step launch flow

| Step | Action | What it does |
| ---- | ------ | ------------ |
| **1** | Deploy app | Deploy an application from the launch project. It hosts the configuration and connection flow that follows. |
| **2** | Authorize Manyfold | Authorize your Manyfold account so the launch flow can establish the agent-connection information needed for this work. |
| **3** | Set up or adopt an agent | Create a new agent or adopt one that already exists; configure its model, development skill, A2A, and needed credentials here. |
| **4** | Link GitHub | Link the application's GitHub repository so the agent has a defined codebase in which to work and can return changes to Git. |
| **5** | Readiness check | Confirm the app, repository, and agent connection states before starting real development tasks. |

The flow can create a new agent or adopt an existing one, allowing a team to retain an established agent's workspace and configuration rather than forcing a restart.

## How the agent keeps developing the app

Once linked, an agent's typical cycle is: understand a task → inspect the connected repository → edit files → run available project checks → commit and push changes. Cloudflare's Git deployment then builds and publishes those changes according to your project configuration.

| Trigger | Result |
| ------- | ------ |
| **The team gives a task** by explaining work to the agent in Manyfold | **The agent changes the GitHub repository** and commits and pushes checked changes |
| **A GitHub change** triggers the configured deployment workflow | **The Cloudflare app updates**, publishing under the project's branch and environment policy |

This is not a direct-production editing path that bypasses Git. By keeping changes in the repository and existing CI/CD workflow, a team can retain branch protection, review, preview environments, and release controls.

## Credentials and security boundaries

The launch project handles two kinds of sensitive information: a management API token used for the setup flow and credentials used by a specific agent conversation. Its README states that this information is stored server-side, and recommends setting `CONFIG_ENCRYPTION_KEY` for a production multi-tenant deployment.

```sh
npx wrangler secret put CONFIG_ENCRYPTION_KEY
```

| Credential or access | How to handle it |
| -------------------- | ---------------- |
| Cloudflare management access | Grant only the scope needed for deployment and configuration; keep or remove it after setup according to team policy. |
| GitHub repository access | Link only repositories and organization scope the agent actually needs, while retaining review and branch protection. |
| Manyfold agent credentials | Bind them to a clear agent and purpose; avoid shared high-privilege tokens. |
| Configuration encryption key | Keep it only as a Cloudflare secret, never in Git, a client, documentation, or screenshots. |

> **An agent that can do coding work does not need unlimited access.** Treat repository permissions, deployment credentials, and production-environment access as separate decisions under your team's policy.

## Pre-launch checklist

- Confirm that the team has a Cloudflare project and the required deployment access.
- Confirm the GitHub repository, default branch, review rules, and deployment policy to link.
- Choose whether to adopt an existing agent or create a new one, then inspect its runtime, model, and skills configuration.
- Prepare least-privilege credentials and a way to rotate and revoke them.
- Run the complete flow in staging or a non-production repository before touching production users or data.

## Frequently asked questions

- **What does the launch flow do?**

  It establishes a Cloudflare app and a Manyfold agent that can keep developing its repository through deployment, authorization, agent setup, GitHub linking, and readiness-check steps.
- **Does an agent automatically get every production permission?**

  It should not be assumed to. Configure GitHub, Cloudflare, and Manyfold credentials with least privilege, and let the team decide which repositories, environments, and deployment workflows the agent can access.
- **Is this project ready to use in production without review?**

  No. Its README is marked Draft; validate it first, particularly the GitHub App-installation and new-repository path.

## See also

- [Worker starter deployment](/docs/deployment/cloudflare-worker/)
- [Manyfold Agent API](/docs/api-chat/)
- [Manyfold open source: cloudflare-worker-launch](https://github.com/manyfold-open/cloudflare-worker-launch)
- [Manyfold open source: Cloudflare Worker starter](https://github.com/manyfold-open/cloudflare-worker-starter)
- [Cloudflare Workers documentation](https://developers.cloudflare.com/workers/)
- [Cloudflare Workers CI/CD documentation](https://developers.cloudflare.com/workers/ci-cd/)
