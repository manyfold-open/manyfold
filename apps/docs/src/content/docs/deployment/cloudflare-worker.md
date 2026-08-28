---
title: Deploy a Cloudflare Worker
description: It deploys an application on Cloudflare that securely connects to a Manyfold agent and brings agent capabilities into your product experience.
order: 14
---
This flow does not deploy Manyfold itself.

Start with [cloudflare-worker-starter](https://github.com/manyfold-open/cloudflare-worker-starter) to deploy a Cloudflare Worker application, then authorize and connect a Manyfold agent inside the app. The agent still runs in Manyfold; the Worker handles the product UI, application API, and data layer.

After deploying, set access protection and secrets before connecting users to an agent. Never place Manyfold or Cloudflare secrets in frontend JavaScript.

## Before you begin

- **Cloudflare Worker deployment**: A Cloudflare account, a Manyfold agent, and basic Git or Wrangler knowledge.
- **A place to keep the token**: The Manyfold API token and the Cloudflare secrets must live in Worker secrets, never in the repository or in browser code.

## What the starter prepares

- **Worker + web UI**: A deployable app foundation that can become the product interface for agent capabilities.
- **Device authorization flow**: A user-confirmed connection flow obtains the authorization needed for agent sessions without handing tokens to the browser.
- **D1 persistence**: The template configures Cloudflare D1 for application data and session-related state.

The starter also demonstrates streaming agent chat, conversation continuation, and file-related interaction. Treat it as an application starting point: add authentication, authorization, and auditing appropriate to your own users and data before production.

## Deployment flow

| Step | Action | What it involves |
| ---- | ------ | ---------------- |
| **1. Choose a starting point** | Use Deploy to Cloudflare or fork the repository | The first is useful for creating a project quickly in the Cloudflare dashboard. The second is useful when a team wants to review and adapt code in its own Git repository first. |
| **2. Create and connect data** | Configure the D1 database | Create D1 from the template's `wrangler.jsonc` configuration and add the corresponding database identifier. Do not commit production credentials to Git. |
| **3. Connect Git deployment** | Let Cloudflare build and deploy on pushes | The template's Git deployment path builds with `npm run build` and publishes with `npx wrangler deploy`. After setup, pushes to the connected branch can trigger a new deployment. |
| **4. Set production secrets** | Store them in Cloudflare, not source code | Set administrator access protection at a minimum. A production multi-tenant deployment should also set a configuration-encryption key. Use Cloudflare secrets rather than a repository or client-side storage. |

```sh
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put CONFIG_ENCRYPTION_KEY
```

`CONFIG_ENCRYPTION_KEY` encrypts connection configuration saved by the app. Enter it interactively in the terminal; do not paste its real value into code, documentation, screenshots, or chat.

## After deployment: connect and verify a Manyfold agent

1. Open the Worker's public URL and complete the app's own administrator or access-protection setup first.
2. Start an agent connection in the app and follow the provided device-authorization steps to sign in and confirm.
3. Select or connect the target Manyfold agent.
4. Send a low-risk test message and verify streaming replies and conversation continuation.
5. Then connect product features, user identity, and business workflows to that chat experience.

> **A public URL does not mean a public agent.** When any visitor can open an app and invoke an agent, unapproved usage and charges can follow. Add your own application authentication and authorization before launch.

## Connect an existing Cloudflare Worker to Manyfold

You do not have to start from the template. An existing Worker can call Manyfold's OpenAI-compatible Chat Completions API from the server side. The request's `model` is a Manyfold Agent ID (such as `agt_...`), not the underlying model-provider name.

```http
POST https://api.manyfold.ai/api/v1/chat/completions
Authorization: Bearer $MF_API_TOKEN
Content-Type: application/json

{
  "model": "agt_your_agent_id",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

Keep `MF_API_TOKEN` in a server-side Worker secret and give the API token only the scopes it needs. Your Worker should decide when to make a call based on verified users, product rules, and rate limits.

## Production security checklist

| Check | Why it matters |
| ----- | -------------- |
| Keep secrets only in Cloudflare secrets | Prevents API tokens, administrator passwords, and encryption keys from reaching the browser or Git history. |
| Authenticate and authorize in the application | Controls who can use an agent, read conversations, or create cost. |
| Test a least-privilege API token | Limits the impact if one credential is exposed. |
| Log and review application requests | Helps investigate unusual traffic, failed calls, and usage costs. |
| Verify outside production first | Validates deployment, data, and authorization behavior before public release. |

## Frequently asked questions

- **Does this template deploy Manyfold itself?**

  No. It deploys a Cloudflare application that can connect to a Manyfold agent through an API.
- **What should I do first after deployment?**

  Set access protection and production secrets, then connect an agent through the device authorization flow. Never put tokens in browser code.
- **Can I connect an existing Worker?**

  Yes. Keep a Manyfold API token as a server-side secret and have the Worker send requests for a selected Agent ID to the Chat Completions API.

## See also

- [Manyfold Agent API](/docs/api-chat/)
- [Compare deployment roles](/docs/deployment/)
- [Manyfold open source: Cloudflare Worker starter](https://github.com/manyfold-open/cloudflare-worker-starter)
- [Cloudflare Workers documentation](https://developers.cloudflare.com/workers/)
- [Cloudflare Workers secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/)
