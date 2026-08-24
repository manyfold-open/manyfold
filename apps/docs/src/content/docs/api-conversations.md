---
title: Read conversations by API
description: List and replay the conversations you created with the OpenAI-compatible v1 API.
order: 6
---
When you talk to an agent with [the Chat Completions API](/docs/api-chat/), each turn returns a
`session_id` (as the `x-session-id` header and `metadata.session_id`). The read API lets you list
those conversations again and replay their messages — useful for dashboards, audits, or resuming a
thread in your own UI.

The read surface adds two endpoints:

```text
GET /api/v1/conversations
GET /api/v1/conversations/{session_id}/messages
```

A `session_id` is the same value `x-session-id` returns from `/api/v1/chat/completions`; there is no
separate conversation id.

## Before you start

Use the same token you use for chat. An API token with the `chat.completions` scope (or `api.full`)
can read your own conversation history — no extra scope is needed. Reads are **not** counted against
your monthly API request quota.

## List conversations

```sh
curl "https://api.manyfold.ai/api/v1/conversations?limit=20" \
  -H "Authorization: Bearer $MF_API_TOKEN"
```

The response is an OpenAI-style list envelope:

```json
{
    "object": "list",
    "data": [
        {
            "object": "conversation",
            "id": "cts_...",
            "model": "agt_your_agent_id",
            "title": "Summarize this repository",
            "created_at": 1764547200,
            "updated_at": 1764547260
        }
    ],
    "first_id": "cts_...",
    "last_id": "cts_...",
    "has_more": false
}
```

- `model` is the Manyfold agent id the conversation belongs to.
- `created_at` / `updated_at` are unix seconds.
- Add `?model=agt_your_agent_id` to list a single agent's conversations.
- Conversations that originate from a channel (Telegram, Slack, …) are not listed.

## Read a conversation's messages

```sh
curl "https://api.manyfold.ai/api/v1/conversations/cts_your_session_id/messages" \
  -H "Authorization: Bearer $MF_API_TOKEN"
```

Each message is OpenAI-shaped for drop-in SDK use, plus a `content_blocks` array that preserves the
full transcript — including tool calls and reasoning from coding agents:

```json
{
    "object": "list",
    "data": [
        {
            "id": "...",
            "object": "message",
            "role": "assistant",
            "content": [
                { "type": "text", "text": "Done. I updated three files." }
            ],
            "content_blocks": [
                { "type": "text", "text": "Done. I updated three files." },
                {
                    "type": "tool_call",
                    "toolName": "Bash",
                    "args": { "cmd": "ls" }
                }
            ],
            "model": "claude-sonnet-4-6",
            "created_at": 1764547260
        }
    ],
    "first_id": "...",
    "last_id": "...",
    "has_more": false
}
```

Parse `content` if you only need the text (it is a standard OpenAI parts array). Read `content_blocks`
when you want the full picture.

## Pagination

Both endpoints share the same paging parameters:

| Parameter | Notes                                                                              |
| --------- | ---------------------------------------------------------------------------------- |
| `limit`   | Optional. 1–100, default 20.                                                       |
| `after`   | Optional. An object id (`first_id` / `last_id` from a previous page) to page past. |
| `order`   | Optional. `desc` (newest first, default) or `asc`.                                 |

When `has_more` is `true`, pass `last_id` as `after` to fetch the next page.

## Scope and visibility

- A token bound to a single agent automatically lists only that agent's conversations; passing a
  different `?model=` is rejected.
- Requesting a conversation that isn't yours, originates from a channel, or doesn't belong to a bound
  token's agent returns `404`.

## Errors

Errors use the same OpenAI-style shape as the Chat Completions API:

```json
{
    "error": {
        "message": "conversation not found",
        "type": "invalid_request_error",
        "code": "conversation_not_found"
    }
}
```

## See also

- [API Reference](/api-reference/)
- [Chat with agents by API](/docs/api-chat/)
