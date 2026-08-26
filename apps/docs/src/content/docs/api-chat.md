---
title: Chat with agents by API
description: Use the OpenAI-compatible Chat Completions API to talk to a Manyfold agent.
order: 6
---
Use the OpenAI-compatible Chat Completions API when you want an external service, script, or OpenAI SDK client to talk to a Manyfold agent.

The public v1 API exposes one integration surface:

```text
POST /api/v1/chat/completions
```

It works with hosted agents such as Claude Code, Codex, Gemini CLI, OpenClaw, Hermes, Dify, and Langflow agents through the same request shape.

## Before you start

1. Create or choose an agent in Manyfold.
2. Copy the agent id. Agent ids start with `agt_`.
3. Open **Settings -> API tokens**.
4. Create an API token with the `chat.completions` scope.
5. Copy the token when it is shown. It will not be shown again.

> **Note:** Use `api.full` only for trusted internal clients that need the broader Manyfold API. For chat integrations, prefer `chat.completions`.

## Endpoint and model

For the hosted product, use:

```text
https://api.manyfold.ai/api/v1/chat/completions
```

If you run a [self-hosted deployment](/docs/self-hosting/), replace the origin with your deployment's API origin.

The `model` field is the Manyfold agent id, not a provider model name:

```json
{
    "model": "agt_your_agent_id",
    "messages": [{ "role": "user", "content": "Summarize this repository." }]
}
```

## Non-streaming request

```sh
curl https://api.manyfold.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $MF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agt_your_agent_id",
    "messages": [
      {
        "role": "system",
        "content": "You are a concise engineering assistant."
      },
      {
        "role": "user",
        "content": "List the next three actions for this project."
      }
    ]
  }'
```

The response follows the OpenAI Chat Completions shape:

```json
{
    "object": "chat.completion",
    "model": "agt_your_agent_id",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "..."
            },
            "finish_reason": "stop"
        }
    ],
    "metadata": {
        "session_id": "cts_...",
        "assistant_message_id": "..."
    }
}
```

Save `metadata.session_id` if you want to continue the same Manyfold session later.

When the agent reasons before answering, that reasoning is returned in `message.reasoning_content` instead of `message.content`, so `content` stays the answer itself. The field is omitted when the agent produced no reasoning.

`finish_reason` is `stop` for a normal turn and `content_filter` when the agent's own content moderation replaced the answer. On a `content_filter` turn, `content` is the replacement answer.

## Streaming request

Set `stream` to `true` to receive Server-Sent Events:

```sh
curl -N https://api.manyfold.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $MF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agt_your_agent_id",
    "stream": true,
    "stream_options": { "include_usage": true },
    "messages": [
      { "role": "user", "content": "Write a short release note." }
    ]
  }'
```

Each event is emitted as:

```text
data: {"object":"chat.completion.chunk",...}

data: [DONE]
```

Answer text arrives in `choices[0].delta.content`. Reasoning, when the agent produces any, arrives in `choices[0].delta.reasoning_content` on its own chunks — concatenate each field separately. Reasoning chunks usually start well before the first answer token, so a client that renders them shows progress sooner.

The stream also includes the `x-session-id` response header. Keep that value if you want to continue the session in a later request.

## Continue a session

Pass `metadata.session_id` to continue an existing Manyfold chat session:

```json
{
    "model": "agt_your_agent_id",
    "metadata": {
        "session_id": "cts_existing_session_id"
    },
    "messages": [
        { "role": "user", "content": "Continue from the last result." }
    ]
}
```

If you omit `metadata.session_id`, Manyfold creates a new session for that request. To list the sessions you have already created and replay their messages, see [Read conversations by API](/docs/api-conversations/).

## Cancel a running turn

The Chat Completions protocol has no cancel verb, and closing the HTTP stream only stops delivery — the agent keeps working on the turn. To actually interrupt it, call the native cancel endpoint with the agent id you use as `model` and the session id from `metadata.session_id` (or the `x-session-id` stream header):

```sh
curl -X POST \
  https://api.manyfold.ai/api/agents/agt_your_agent_id/sessions/cts_session_id/cancel \
  -H "Authorization: Bearer $MF_API_TOKEN"
```

- The endpoint needs an API token with the `chat:edit` scope (`api.full` also works). The `chat.completions` scope alone cannot cancel; add `chat:edit` to the token if your integration needs to stop turns.
- It returns `204 No Content` and cancels the session's latest running assistant turn. If nothing is running, it changes nothing.
- The cancelled turn ends with the error code `cancelled_by_user`. Output produced before the cancel stays in the session.
- For a Dify agent, the cancel also stops the connected Dify app's generation instead of leaving it running in the background.

## Send files

A `user` message can carry image and file content parts alongside text. Files attach to the **latest** user message:

```sh
curl https://api.manyfold.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $MF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agt_your_agent_id",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "What is in this image?" },
          { "type": "image_url", "image_url": { "url": "https://example.com/diagram.png" } }
        ]
      }
    ]
  }'
```

- `image_url.url` may be a public `https://` URL (fetched server-side) or a base64 `data:` URL (`data:image/png;base64,...`).
- For documents, use a `file` part: `{ "type": "file", "file": { "filename": "report.pdf", "file_data": "data:application/pdf;base64,..." } }`.
- Up to 10 files per message, 25 MB each. A base64 file also counts toward the request body limit (~32 MB), so prefer a URL for large files.
- Files reach Dify agents as native attachments and coding agents (Claude Code, Codex, …) as files in the agent workspace. For a Dify agent, the connected Dify app must have file upload enabled. Self-hosted deployments must configure chat-upload storage for Dify file attachments.

## OpenAI SDK example

Most OpenAI-compatible clients let you override the base URL:

```ts
import OpenAI from 'openai'

const client = new OpenAI({
    apiKey: process.env.MF_API_TOKEN,
    baseURL: 'https://api.manyfold.ai/api/v1'
})

const response = await client.chat.completions.create({
    model: 'agt_your_agent_id',
    messages: [
        { role: 'user', content: 'Check the deployment plan for risks.' }
    ]
})

console.log(response.choices[0]?.message?.content)
```

## Supported request fields

The endpoint accepts the common Chat Completions fields:

| Field                                | Notes                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `model`                              | Required. Must be a Manyfold agent id.                                            |
| `messages`                           | Required. `system`/`developer`/`user`/`assistant` messages. A `user` message may include `image_url` and `file` content parts — see [Send files](#send-files). |
| `stream`                             | Optional boolean. Use `true` for SSE chunks.                                      |
| `temperature`, `top_p`, `max_tokens` | Accepted when they are finite numbers.                                            |
| `metadata.session_id`                | Optional Manyfold session id to continue.                                         |
| `stream_options.include_usage`       | Optional. When `true`, streaming can include a usage chunk if usage is available. |

Image and file content parts are supported (see [Send files](#send-files)). Tool calls, function calls, and raw provider-specific response formats are not part of the v1 public API.

## Permission defaults

Coding-agent turns started through this API run unrestricted by default:

| Framework   | Default                                             |
| ----------- | --------------------------------------------------- |
| Claude Code | `bypassPermissions`                                 |
| Codex       | Full access, with approvals and sandboxing bypassed |
| Gemini CLI  | `--approval-mode yolo`                              |

These defaults let API-driven agents complete file edits, terminal commands, and workspace automation without interactive approval prompts. The OpenAI-compatible v1 endpoint does not expose per-request permission controls; use the Manyfold chat UI or native chat API when you need to choose a narrower mode for a turn.

## Errors

Errors use an OpenAI-style shape:

```json
{
    "error": {
        "message": "API token does not have chat.completions scope",
        "type": "authentication_error",
        "code": "invalid_api_key"
    }
}
```

Common fixes:

- Use an `nca_` API token, not a browser session token.
- Create the token with `chat.completions` or `api.full` scope.
- Confirm `model` is an agent id that belongs to the token owner.
- To send images or documents, use `image_url`/`file` content parts (see [Send files](#send-files)).

## See also

- [API Reference](/api-reference/)
- [Read conversations by API](/docs/api-conversations/)
- [Call agents over A2A](/docs/api-a2a/)
- [Create your first agent](/docs/create-agent/)
