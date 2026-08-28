---
title: Manyfold and Cloudflare
description: Manyfold does not replace Cloudflare, Vercel, or another deployment platform. It manages agents; a deployment platform hosts the app that reaches users.
order: 13
---
**Manyfold is an agent platform; Cloudflare and Vercel are application deployment platforms.** Manyfold lets teams create, run, and manage agents. Cloudflare or Vercel deploys the website, APIs, and backend capabilities used by customers. That deployed application can call the Manyfold Agent API from its server side.

The two connect through an API, with a clear boundary between agent work and a production application.

So the question is not "why can't I use Vercel with Manyfold?" It is "where does my application run, and how does it connect safely to an agent?" Manyfold does not require any particular cloud provider for application deployment.

## Before you begin

- **Manyfold and deployment platforms**: A Manyfold agent, an application backend that can keep server-side secrets, and the deployment platform you choose.
- **Keep secrets server-side**: Use official docs, least-privilege credentials, and a staging check before production.

## Different roles, one workflow

| Layer | Component | Responsibility |
| ----- | --------- | -------------- |
| **Agent** | Manyfold | Hosts and manages agent workspaces, sessions, model settings, skills, channels, and runtime state, and exposes APIs for talking with an agent. |
| **Application and infrastructure** | Cloudflare or Vercel | Hosts the customer-facing frontend, backend APIs, deployment workflow, and runtime capabilities. The application keeps credentials on the server side and calls Manyfold. |
| **Experience** | Your product and its users | People interact with your website, product UI, or business workflow. Your application passes appropriate work to a chosen Manyfold agent. |

This is a division of responsibilities, not a binding relationship. The application layer can use Cloudflare, Vercel, or another compatible hosting environment.

| Question | Manyfold | Cloudflare / Vercel |
| -------- | -------- | ------------------- |
| Who runs and manages the agent? | Agent runtime, workspace, sessions, model, and collaboration configuration. | Not the primary role. |
| Who deploys a public website and business APIs? | Not the primary role. | Application code, runtime environment, and delivery workflow. |
| Who makes the agent call? | Provides an API for a selected agent. | The application backend keeps the token, calls the API, and presents the result to its users. |
| Who supplies infrastructure capabilities? | Agent runtime and team-management capabilities. | Compute, storage, logs, CI/CD, and other platform capabilities as selected. |

## Why use Cloudflare as the example?

Cloudflare Workers is a serverless platform for deploying full-stack apps and APIs, with access to platform capabilities such as D1, R2, Queues, and Workflows. Manyfold's open-source [Cloudflare Worker starter](https://github.com/manyfold-open/cloudflare-worker-starter) makes a concrete starting point for connecting an agent, chatting to verify the connection, and building an app on top of it.

- **Worker starter**: For teams that want to start from a Cloudflare application template with Manyfold agent connectivity already included.
- **Workers and bindings**: An app can bring public requests, databases, object storage, asynchronous work, and external services into one deployment architecture.
- **Manyfold remains the agent layer**: The Worker hosts your product; Manyfold operates and manages the connected agent.

This makes Cloudflare a documented and templated implementation path. **It does not make Cloudflare the only or mandatory way to use Manyfold.**

## Where Vercel fits

Vercel can also deploy web applications and server-side functions, with Git-centered Preview and Production deployment workflows. If your project is already on Vercel, its server side can call the Manyfold Agent API; adopting Manyfold does not require a platform migration.

> **Do not put an API token in the browser.** Whether the app runs on Cloudflare, Vercel, or another platform, keep the Manyfold API token in server-side environment variables or a secret manager. The browser should call your application backend instead.

The relevant evaluation is the application itself: existing team workflow, framework, data services, runtime requirements, and operational constraints. Manyfold lives at the agent layer and can coexist with those deployment choices.

## A minimal safe connection pattern

| Calls | Reaches |
| ----- | ------- |
| **Browser / client** calls only your app API | **Cloudflare, Vercel, or another backend** keeps the secret and calls Manyfold |
| **Application backend** uses server-side credentials | **Manyfold Agent API** routes the request to a chosen agent |

Manyfold's Chat Completions API uses an Agent ID as the `model` value rather than exposing a provider-model name directly to the app. A public product should also implement its own authentication, authorization, rate limiting, and audit policy at the application layer.

## Frequently asked questions

- **Do I have to use Cloudflare with Manyfold?**

  No. Manyfold provides an Agent API. Any application backend that can safely keep credentials and make HTTPS requests can connect to it.
- **Can Manyfold deploy my website?**

  Manyfold is centered on running, managing, and collaborating with agents. Cloudflare, Vercel, or another application infrastructure should deploy the website and business APIs.
- **Does a team already using Vercel need to migrate to Cloudflare?**

  No. A Vercel application can call the Manyfold API from its server side too. The Cloudflare starter is a provided implementation example, not a migration requirement.
- **Why not call Manyfold directly from the frontend?**

  A direct call would expose the API token to visitors. Your own backend should retain credentials, perform access control, and return only the necessary result to the frontend.

## See also

- [Cloudflare Worker starter](/docs/deployment/cloudflare-worker/)
- [Cloudflare continuous development](/docs/deployment/cloudflare-app/)
- [Manyfold Agent API](/docs/api-chat/)
- [Manyfold open source: Cloudflare Worker starter](https://github.com/manyfold-open/cloudflare-worker-starter)
- [Cloudflare Workers documentation](https://developers.cloudflare.com/workers/)
- [Vercel Functions documentation](https://vercel.com/docs/functions)
- [Vercel Git deployments documentation](https://vercel.com/docs/git)
