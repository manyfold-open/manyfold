# Manyfold workbench routes

## Select the Web origin

Keep the Web page and CLI on the same deployment and account.

1. Honor the user's explicit Web URL or an already-verified Manyfold
   workbench URL for the target deployment.
2. Determine the effective API URL: an explicit `--api-url` or `MF_API_URL`
   overrides the profile's saved `apiUrl`, which is shown safely by
   `mf --profile <profile> profile show --json`. The profile command reports
   saved configuration, not per-command overrides. Without any override or
   saved URL, the CLI default is `https://api.manyfold.ai/api`.
3. For the hosted production deployment, use this exact pair (ignoring only
   a trailing slash):

| API base URL | Web origin |
| --- | --- |
| `https://api.manyfold.ai/api` | `https://manyfold.ai` |

For other deployments, including staging, local, and self-hosted instances,
use the Web URL supplied by the user,
the deployment's startup output, or verified browser context. If it is still
unknown, ask for that URL while continuing authorized CLI work. Do not infer
it by removing `/api`, replacing a hostname, or incrementing a port.
A profile named `dev` or `staging` and the CLI update channel do not establish
the deployment.

Use only a verified HTTP(S) origin. Browser authentication is separate from
CLI authentication; let the user sign in normally when needed. Never append
CLI tokens or invent a login ticket.

## Route table

All paths below are relative to the selected Web origin. Replace path
placeholders with URL-encoded resource IDs from CLI responses. Use
`URLSearchParams` for query values. Names and titles are not IDs.

| Resource or view | Path |
| --- | --- |
| Workspace / agents | `/workspace` |
| Agent chat | `/agents/{agentId}/chat` |
| Specific conversation | `/agents/{agentId}/chat?sessionId={chatSessionId}` |
| Agent settings | `/agents/{agentId}/settings/overview` |
| Agent model configuration | `/agents/{agentId}/settings/model` |
| Agent installed skills | `/agents/{agentId}/settings/skills` |
| Agent MCP configuration | `/agents/{agentId}/settings/mcp` |
| Agent files and backups settings | `/agents/{agentId}/settings/storage` |
| Agent permissions | `/agents/{agentId}/settings/permissions` |
| Agent channels | `/agents/{agentId}/settings/channels` |
| Agent connections | `/agents/{agentId}/settings/connections` |
| Agent A2A access | `/agents/{agentId}/settings/a2a` |
| Automations list | `/automations` |
| Automation detail and recent runs | `/automations/{automationId}` |
| Channels list | `/settings/channels` |
| Channel detail | `/settings/channels/{channelId}` |
| Runtimes list | `/settings/runtimes` |
| Runtime detail | `/settings/runtimes/{runtimeId}` |
| Sandbox or daemon host | `/settings/runtimes?host={hostId}` |
| Skill catalog / personal library | `/skills` / `/skills/library` |
| MCP catalog / personal library | `/mcp` / `/mcp/library` |
| Connections list / detail | `/connections` / `/connections/{connectionId}` |
| Model providers | `/settings/model-providers` |
| Usage | `/settings/usage` |

Agent settings availability depends on the framework and runtime. The storage
settings page is not a file preview. To show workspace file contents, open
the agent chat and its Files panel through supported browser controls; there
is no documented per-file URL here.

## Automation run conversations

- Save the automation's `agentId` at submission together with the returned
  run ID. Read `mf automations get <automationId> --json` and match that exact
  run in `runs`; use its `chatSessionId` only after it is non-null.
- A run ID belongs to the automation run. It is not a chat session ID and
  must never be substituted into `sessionId`.
- An automation can later be assigned to another agent. For a historical
  run, use its original agent ID only when established by saved run context
  or a verified conversation URL. Current run summaries do not expose the
  original agent ID. If it is unknown, open the automation detail page and
  leave the conversation link unresolved instead of guessing from the
  automation's current agent.

For a newly submitted run with known context:

```js
const url = new URL(
    `/agents/${encodeURIComponent(runAgentId)}/chat`,
    webOrigin
)
url.searchParams.set('sessionId', run.chatSessionId)
```

Reuse the existing workbench tab and keep the current page open during live
updates. Navigating is a user-facing handoff, not the refresh mechanism.
Verify the destination's account, resource, and visible result.

Maintainers: this reference is shared by the standalone skill and plugin.
Check route changes against `apps/web/src/App.tsx`,
`apps/web/src/lib/agentSettingsSections.ts`, and the runtime/chat page query
parameters. Keep the route rules in this skill reference.
