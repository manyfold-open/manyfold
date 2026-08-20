---
title: Call agents over A2A
description: Let an external client or SDK call a Manyfold agent through the A2A protocol.
order: 6
---

# Call agents over A2A

Manyfold can publish an agent as an [A2A](https://a2a-protocol.org/) server, so any A2A client — an official SDK, another agent platform, or plain `curl` — can send it work and read the result.

Use this when the caller speaks A2A. If you just want an HTTP chat endpoint, use the [OpenAI-compatible Chat API](../api-chat/) instead.

## 1. Expose the agent

Open the agent, go to the **A2A** tab, and turn on the exposure switch. Until it is on, every A2A request returns `404` — an unexposed agent is indistinguishable from one that does not exist.

You can do the same from the CLI. An agent runtime always manages itself;
when using `mf login` or a personal API token, select an agent you own with
the global `--agent-id` flag (or `MF_AGENT_ID`):

```bash
mf --agent-id {agentId} a2a exposure enable
mf --agent-id {agentId} a2a exposure get
```

The tab shows the agent's two public URLs:

```text
GET  /api/a2a/agents/{agentId}/agent-card.json
POST /api/a2a/agents/{agentId}/rpc
```

## 2. Create a token for your client

Still on the **A2A** tab: **Add caller → External client**. Give it a name (for example `zapier-integration`), optionally an expiry in days, and copy the token — it is shown only once.

Or create it from the CLI:

```bash
mf --agent-id {agentId} a2a callers add \
  --external \
  --name zapier-integration \
  --expires-in-days 30
```

In human mode stdout contains only the one-time bearer, so it can be
redirected straight into a secret store; the warning and endpoint details
go to stderr. `--json` returns the complete response, including that
one-time token. The CLI does not save the token and cannot print it again.

Adding a caller does **not** enable exposure. Keep these as two deliberate
steps, and use `mf a2a exposure enable` when you want the public A2A server
to become reachable.

A few things to know about that token:

- It calls **only this agent**. Pointing it at another of your agents returns `403`.
- It is a Bearer token: send `Authorization: Bearer <token>`.
- Revoking it from the callers list takes effect on the very next call.
- A personal API token from **Settings → API tokens** does *not* work here, even with the `a2a:edit` scope. Only a token minted through **External client** does.

Use `mf a2a callers list` to inspect peer and External client grants, and
`mf a2a callers revoke <tokenId> --yes` to revoke one. Listing and reading
exposure requires `a2a:read`; enabling, disabling, adding, and revoking
requires `a2a:edit`.

## 3. Connect an app without copy and paste

An app can use the device-code Connect flow to let a signed-in user choose one or more agents. The app never needs the user's Manyfold session or personal API token.

Start a 15-minute connection session without authentication:

```bash
curl -X POST https://api.manyfold.ai/api/connect/a2a/start \
  -H "Content-Type: application/json" \
  -d '{
    "clientName": "Team Agents",
    "clientUrl": "https://team-agents.example.com"
  }'
```

`clientName` is required (60 characters maximum). `clientUrl` is optional (200 characters maximum) and must use HTTPS. Both values are self-reported and shown as **unverified** on the authorization page.

```json
{
  "requestId": "acs_…",
  "userCode": "UQMU-2H6P",
  "authUrl": "https://manyfold.ai/connect/a2a?request=acs_…&code=UQMU-2H6P",
  "deviceCode": "mf_cnx_…",
  "expiresAt": "2026-08-05T12:15:00.000Z"
}
```

Show `userCode` in your app and open `authUrl`. The user signs in to Manyfold, verifies the code, chooses up to 20 agents, and decides whether to enable A2A exposure. Keep `deviceCode` secret: it is returned only by `start`, and Manyfold stores only its hash.

Poll every two seconds:

```bash
curl -X POST https://api.manyfold.ai/api/connect/a2a/poll \
  -H "Content-Type: application/json" \
  -d '{ "deviceCode": "mf_cnx_…" }'
```

While the user is deciding, the response is `{ "status": "pending" }`. A denial or timeout returns `denied` or `expired`. The first poll after approval returns credentials exactly once:

```json
{
  "status": "approved",
  "userEmail": "owner@example.com",
  "agents": [
    {
      "agentId": "agt_…",
      "name": "release-agent",
      "rpcUrl": "https://api.manyfold.ai/api/a2a/agents/agt_…/rpc",
      "cardUrl": "https://api.manyfold.ai/api/a2a/agents/agt_…/agent-card.json",
      "token": "nca_…",
      "expiresAt": null
    }
  ]
}
```

Store every token immediately. Each selected agent gets an independent, single-target External client token; a repeated or concurrent losing poll returns `expired` and never repeats credentials. No token exists before the winning poll. A `403` from that agent's RPC endpoint means the grant was revoked or expired and the user should reconnect.

The full endpoint contract is:

| Endpoint | Authentication | Purpose |
| --- | --- | --- |
| `POST /api/connect/a2a/start` | None | Start a session from `{clientName, clientUrl?}`; rate-limited by source IP. |
| `GET /api/connect/a2a/session/{requestId}/{userCode}` | None | Read unverified client metadata and status for the authorization page; rate-limited by source IP. |
| `POST /api/connect/a2a/approve` | Human session only | Approve `{requestId, userCode, agentIds, enableExposure?, expiresInDays?}`; records consent but returns no token. |
| `POST /api/connect/a2a/deny` | Human session only | Deny `{requestId, userCode}`. |
| `POST /api/connect/a2a/poll` | Device code | Consume approval and return per-agent credentials once; rate-limited by source IP. |

The Connect device code is not a Manyfold API bearer and cannot be exchanged through the CLI login flow. Users revoke the resulting tokens from each agent's A2A callers list; there is no app-wide disconnect endpoint yet.

## 4. Fetch the Agent Card

The card is public — no token needed — and reports the protocol version, transport, and skills:

```bash
curl https://api.manyfold.ai/api/a2a/agents/{agentId}/agent-card.json
```

The same card is served at `/.well-known/agent-card.json` under the agent path, so SDKs that resolve a card from a base URL work without being handed the full card URL:

```python
from a2a.client import A2ACardResolver

resolver = A2ACardResolver(
    httpx_client,
    base_url="https://api.manyfold.ai/api/a2a/agents/{agentId}",
)
card = await resolver.get_agent_card()
```

## 5. Send a message

`message/send` runs one turn and returns the finished task:

```bash
curl -X POST https://api.manyfold.ai/api/a2a/agents/{agentId}/rpc \
  -H "Authorization: Bearer $MF_A2A_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "kind": "message",
        "role": "user",
        "parts": [{ "kind": "text", "text": "Summarize today’s open PRs." }],
        "messageId": "11111111-2222-3333-4444-555555555555"
      }
    }
  }'
```

The reply is a JSON-RPC envelope wrapping an A2A task:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "kind": "task",
    "id": "aat_…",
    "contextId": "aac_…",
    "status": { "state": "completed", "timestamp": "2026-07-26T20:39:45.757Z" },
    "artifacts": [{ "artifactId": "artifact-1", "parts": [{ "kind": "text", "text": "…" }] }]
  }
}
```

`message.kind`, `message.role`, `message.parts` and `message.messageId` are all required — a message without them is rejected with JSON-RPC error `-32602`. Reuse a `messageId` and you get the original task back instead of a second turn, which makes retries safe.

### Continue a conversation

Pass the `contextId` from an earlier task to keep the same session:

```json
"message": {
  "kind": "message",
  "role": "user",
  "contextId": "aac_…",
  "parts": [{ "kind": "text", "text": "Now group them by author." }],
  "messageId": "66666666-7777-8888-9999-000000000000"
}
```

Only tasks created by *your* token are addressable this way.

### Long turns

Two options when a turn may run for a while:

- **Stream** — `message/stream` returns Server-Sent Events (`status-update`, then `artifact-update` chunks).
- **Submit and poll** — send `message/send` with `"configuration": { "blocking": false }`, get a `working` task immediately, then poll `tasks/get` with the task id.

## Supported methods

| Method | Purpose |
| --- | --- |
| `message/send` | Run one turn (blocking, or `blocking:false` to submit and poll) |
| `message/stream` | Run one turn and stream events over SSE |
| `tasks/get` | Fetch one task by id |
| `tasks/list` | List your token's tasks on this agent |
| `tasks/cancel` | Cancel a task that has not finished |
| `tasks/resubscribe` | Re-attach to a task's events |

## Errors

Transport and authorization problems come back as an HTTP status with `{"error": "..."}`. Problems with the call itself come back as HTTP `200` with a JSON-RPC `error` object.

| Status | Meaning |
| --- | --- |
| `401` | Missing, revoked, or expired token |
| `403` | The token is not an External client token for this agent |
| `404` | Unknown agent, or A2A exposure is off |
| `429` | Rate limit — retry after the window |
| `200` + `error` | Bad params, unknown method, or unknown task |

A2A calls count toward the same API quota as the rest of your account.
